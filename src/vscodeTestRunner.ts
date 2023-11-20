/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { PythonExtension } from '@vscode/python-extension';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { AddressInfo, createServer } from 'net';
import * as path from 'path';
import * as vscode from 'vscode';
import { TestOutputScanner } from './testOutputScanner';
import { TestCase, TestFile, TestSuite, itemData } from './testTree';

/**
 * From MDN
 * @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_Expressions#Escaping
 */
const escapeRe = (s: string) => s.replace(/[.*+\-?^${}()|[\]\\]/g, '\\$&');

const TEST_ELECTRON_SCRIPT_PATH = 'test/unit/electron/index.js';
const TEST_BROWSER_SCRIPT_PATH = 'test/unit/browser/index.js';

const ATTACH_CONFIG_NAME = 'Attach to VS Code';
const DEBUG_TYPE = 'pwa-chrome';

// listen/connect are mutually exclusive. If the vscode configuration is listen, then the debugpy arguments
// must use connect. And vice-versa.
class debugConfig implements vscode.DebugConfiguration {
    // [key: string]: any;
    type: string;
    name: string;
    request: string;
    listen: {
        port: number;
        host: string;
    }
    // module: string;
    // args: string[];
    subProcess: boolean;
    // connect: {
    //     host: string;
    //     port: number;
    // };

    constructor() {
        // this.key = 'KT Debug Config';
        this.name = 'Python: Remote Attach';
        this.type = 'python';
        this.request = 'attach';
        this.listen = {
            port: 5678,
            host: 'localhost'
        }
        // this.module = 'main';
        // this.args = args;
        this.subProcess = true;
        // this.connect = {
        //     host: '127.0.0.1',
        //     port: 5678
        // };
    }

}

export abstract class VSCodeTestRunner {
    constructor(protected readonly repoLocation: vscode.WorkspaceFolder) {}

    public async run(baseArgs: ReadonlyArray<string>, filter?: ReadonlyArray<vscode.TestItem>) {
        const args = this.prepareArguments(baseArgs, filter);

        const pythonApi: PythonExtension = await PythonExtension.api();
        const environmentPath = pythonApi.environments.getActiveEnvironmentPath();
        const testList: string[] = [];

        const findTests = (t: vscode.TestItem) => {
            if (t.canResolveChildren) {
                t.children.forEach(item => findTests(item))
            } else {
                testList.push(t.id)
            }
        };
        
        if (filter) {
                
            for (const [index, item] of filter.entries()) {
                findTests(item)
            }
        }

        console.log('Final List:')
        console.log(testList.toString())
        console.log(JSON.stringify(testList))
        // console.log('getEnvironment()')
        // console.log(this.getEnvironment())

        const runMain = spawn(
                environmentPath.path,
                [path.join(this.repoLocation.uri.fsPath, `main.py`), '-tests', JSON.stringify(testList)], 
        {
            env: this.getEnvironment(),
            cwd: this.repoLocation.uri.fsPath
        });

        // const cp = spawn(await this.binaryPath(), args, {
        //     cwd: this.repoLocation.uri.fsPath,
        //     stdio: 'pipe',
        //     env: this.getEnvironment(),
        // });

        console.log('Spawn Args')
        console.log(runMain.spawnargs)

        return new TestOutputScanner(runMain, undefined);
    }

    public async debug(baseArgs: ReadonlyArray<string>, filter?: ReadonlyArray<vscode.TestItem>) {
        const server = this.createWaitServer();

        const testList: string[] = [];

        const findTests = (t: vscode.TestItem) => {
            if (t.canResolveChildren) {
                t.children.forEach(item => findTests(item))
            } else {
                testList.push(t.id)
            }
        };
        
        if (filter) {
                
            for (const [index, item] of filter.entries()) {
                findTests(item)
            }
        }


                // .concat([
                //         '-m',
                //         'main'
                // ])
        // .concat([
        //         path.join(this.repoLocation.uri.fsPath, `main.py`), 
        //         '-tests', JSON.stringify(testList)
        // ])

        const args2 = [
            '/Users/cw10054077/.vscode/extensions/ms-python.python-2023.20.0/pythonFiles/lib/python/debugpy/launcher',
            'localhost:5678',
            '--',
            path.join(this.repoLocation.uri.fsPath, `main.py`), 
            '-tests', JSON.stringify(testList)
        ]

        const pythonApi: PythonExtension = await PythonExtension.api();
        console.log(await pythonApi.debug.getDebuggerPackagePath())
        const debugCmds = await (await pythonApi.debug.getRemoteLauncherCommand('127.0.0.1', 5678, true))

        const debugCmds2 = debugCmds.concat([
            '--log-to-stderr',
            path.join(this.repoLocation.uri.fsPath, `main.py`), 
            '-tests', JSON.stringify(testList)
            // '-Xfrozen_modules=off'
        ])

        debugCmds2[1] = '--connect';

        const environmentPath = pythonApi.environments.getActiveEnvironmentPath();
        const debugMain = spawn(
                environmentPath.path,
                debugCmds2, 
                {
                        env: this.getEnvironment(),
                        cwd: this.repoLocation.uri.fsPath,
                        stdio: 'pipe'
                }
        );
        
                
        console.log('Debug Args:')
        console.log(debugMain.spawnargs)

        // Register a descriptor factory that signals the server when any
        // breakpoint set requests on the debugee have been completed.
        const factory = vscode.debug.registerDebugAdapterTrackerFactory('*', {
            createDebugAdapterTracker(session) {
                if (!session.parentSession || session.parentSession !== rootSession) {
                    return;
                }

                let initRequestId: number | undefined;

                return {
                    onDidSendMessage(message) {
                        if (message.type === 'response' && message.request_seq === initRequestId) {
                            server.ready();
                        }
                    },
                    onWillReceiveMessage(message) {
                        if (initRequestId !== undefined) {
                            return;
                        }

                        if (message.command === 'launch' || message.command === 'attach') {
                            initRequestId = message.seq;
                        }
                    },
                };
            },
        });

        const pythonDebug = new debugConfig();
        // pythonDebug.connect.port = 5678;

        debugMain.once('message', (event) => {
            console.log('debugMain Message');
            console.log(event);

            // console.log('Started Debugging')
            // vscode.debug.startDebugging(this.repoLocation, pythonDebug).then(() => {
            //     console.log('Successfully Started Debugging');
            // });
        });


        
        console.log('Started Debugging')
        vscode.debug.startDebugging(this.repoLocation, pythonDebug).then(() => {
            console.log('Successfully Started Debugging');
        });

        debugMain.once('spawn', () => {
            console.log('Spawned CLI for Debugpy')

        });
        // debugCmds2[1] = '--connect';

        // const environmentPath = pythonApi.environments.getActiveEnvironmentPath();
        // const debugMain = spawn(
        //         environmentPath.path,
        //         debugCmds2, 
        //         {
        //                 env: this.getEnvironment(),
        //                 cwd: this.repoLocation.uri.fsPath,
        //                 stdio: 'pipe'
        //         }
        // );
                
        // console.log('Debug Args:')
        // console.log(debugMain.spawnargs)

        let exited = false;
        let rootSession: vscode.DebugSession | undefined;
        debugMain.once('exit', () => {
            exited = true;
            server.dispose();
            listener.dispose();
            factory.dispose();

            if (rootSession) {
                vscode.debug.stopDebugging(rootSession);
            }
        });

        const listener = vscode.debug.onDidStartDebugSession(s => {
            if (s.name === pythonDebug.name && !rootSession) {
                if (exited) {
                    vscode.debug.stopDebugging(rootSession);
                } else {
                    rootSession = s;
                }
            }
        });

        return new TestOutputScanner(debugMain, undefined);
    }

    protected getEnvironment(): NodeJS.ProcessEnv {
        return {
            ...process.env,
            PYDEVD_DISABLE_FILE_VALIDATION: '1'
            // PATH: process.env.PATH + ':/Users/cw10054077/Repositories/AutomationFramework/downloads/chromedriver-mac-x64/',
            // VSCODE_CWD: this.repoLocation.uri.fsPath,
            // PWD: this.repoLocation.uri.fsPath
        //     ELECTRON_RUN_AS_NODE: undefined,
        //     ELECTRON_ENABLE_LOGGING: '1',
        };
    }

    private prepareArguments(
        baseArgs: ReadonlyArray<string>,
        filter?: ReadonlyArray<vscode.TestItem>
    ) {
        const args = [...this.getDefaultArgs(), ...baseArgs, '--reporter', 'full-json-stream'];
        if (!filter) {
            return args;
        }

        const grepRe: string[] = [];
        const runPaths = new Set<string>();
        const addTestFileRunPath = (data: TestFile) =>
            runPaths.add(
                path.relative(data.workspaceFolder.uri.fsPath, data.uri.fsPath).replace(/\\/g, '/')
            );

        for (const test of filter) {
            const data = itemData.get(test);
            if (data instanceof TestCase || data instanceof TestSuite) {
                grepRe.push(escapeRe(data.fullName) + (data instanceof TestCase ? '$' : ' '));
                for (let p = test.parent; p; p = p.parent) {
                    const parentData = itemData.get(p);
                    if (parentData instanceof TestFile) {
                        addTestFileRunPath(parentData);
                    }
                }
            } else if (data instanceof TestFile) {
                addTestFileRunPath(data);
            }
        }

        if (grepRe.length) {
            args.push('--grep', `/^(${grepRe.join('|')})/`);
        }

        if (runPaths.size) {
            args.push(...[...runPaths].flatMap(p => ['--run', p]));
        }

        return args;
    }

    protected abstract getDefaultArgs(): string[];

    protected abstract binaryPath(): Promise<string>;

    protected async readProductJson() {
        const projectJson = await fs.readFile(
            path.join(this.repoLocation.uri.fsPath, 'product.json'),
            'utf-8'
        );
        try {
            return JSON.parse(projectJson);
        } catch (e) {
            throw new Error(`Error parsing product.json: ${(e as Error).message}`);
        }
    }

    private createWaitServer() {
        const onReady = new vscode.EventEmitter<void>();
        let ready = false;

        const server = createServer(socket => {
            if (ready) {
                socket.end();
            } else {
                onReady.event(() => socket.end());
            }
        });

        server.listen(0);

        return {
            port: (server.address() as AddressInfo).port,
            ready: () => {
                ready = true;
                onReady.fire();
            },
            dispose: () => {
                server.close();
            },
        };
    }
}

export class BrowserTestRunner extends VSCodeTestRunner {
    /** @override */
    protected binaryPath(): Promise<string> {
        return Promise.resolve(process.execPath);
    }

    /** @override */
    protected getEnvironment() {
        return {
            ...super.getEnvironment(),
            ELECTRON_RUN_AS_NODE: '1',
        };
    }

    /** @override */
    protected getDefaultArgs() {
        return [TEST_BROWSER_SCRIPT_PATH];
    }
}

export class WindowsTestRunner extends VSCodeTestRunner {
    /** @override */
    protected async binaryPath() {
        const { nameShort } = await this.readProductJson();
        return path.join(this.repoLocation.uri.fsPath, `.build/electron/${nameShort}.exe`);
    }

    /** @override */
    protected getDefaultArgs() {
        return [TEST_ELECTRON_SCRIPT_PATH];
    }
}

export class KTTestRunner extends VSCodeTestRunner {
        
        protected async binaryPath(): Promise<string> {
                return ''
        }

        protected getDefaultArgs(): string[] {
                return []
        }

}

export class PosixTestRunner extends VSCodeTestRunner {
    /** @override */
    protected async binaryPath() {
        const { applicationName } = await this.readProductJson();
        return path.join(this.repoLocation.uri.fsPath, `.build/electron/${applicationName}`);
    }

    /** @override */
    protected getDefaultArgs() {
        return [TEST_ELECTRON_SCRIPT_PATH];
    }
}

export class DarwinTestRunner extends PosixTestRunner {
    /** @override */
    protected getDefaultArgs() {
        return [
            TEST_ELECTRON_SCRIPT_PATH,
            '--no-sandbox',
            '--disable-dev-shm-usage',
            '--use-gl=swiftshader',
        ];
    }

    /** @override */
    protected async binaryPath() {
        const { nameLong } = await this.readProductJson();
        return path.join(
            this.repoLocation.uri.fsPath,
            `.build/electron/${nameLong}.app/Contents/MacOS/Electron`
        );
    }
}

export const PlatformTestRunner =
    process.platform === 'win32'
        ? WindowsTestRunner
        : process.platform === 'darwin'
        ? DarwinTestRunner
        : PosixTestRunner;
