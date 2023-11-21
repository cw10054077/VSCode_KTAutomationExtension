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

/**
 * From MDN
 * @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_Expressions#Escaping
 */
const escapeRe = (s: string) => s.replace(/[.*+\-?^${}()|[\]\\]/g, '\\$&');

const DEBUGPY_HOST = 'localhost';
const DEBUGPY_PORT = 5678;

class debugConfig implements vscode.DebugConfiguration {
    type: string;
    name: string;
    request: string;
    subProcess: boolean;
    connect: {
        host: string;
        port: number;
    };

    constructor() {
        this.name = 'Python: Remote Attach';
        this.type = 'python';
        this.request = 'attach';
        this.subProcess = true;
        this.connect = {
            host: DEBUGPY_HOST,
            port: DEBUGPY_PORT
        };
    }

}

// Recursively iterate through the Test Tree's heirarchy and build a flat list of each test's ID
const getTestIDsFromTestItemTree = (filter?: ReadonlyArray<vscode.TestItem>): string[] => {
    const tempList: string[] = [];

    const findTests = (t: vscode.TestItem) => {
        if (t.canResolveChildren) {
            t.children.forEach(item => findTests(item))
        } else {
            tempList.push(t.id)
        }
    };

    if (filter) {
        for (const item of filter.values()) {
            findTests(item)
        }
    }

    return tempList;
}

export class VSCodeTestRunner {
    constructor(protected readonly repoLocation: vscode.WorkspaceFolder) {}

    /**
     * Run the Automation Framework with the tests contained within filter. 
     */
    public async run(baseArgs: ReadonlyArray<string>, filter?: ReadonlyArray<vscode.TestItem>) {
        const pythonApi: PythonExtension = await PythonExtension.api();
        const environmentPath = pythonApi.environments.getActiveEnvironmentPath();
        const testList = getTestIDsFromTestItemTree(filter);

        // Run the framework using the currently active python environment.
        // Pass in the testID's and other configurations.
        const runMain = spawn(
                environmentPath.path,
                [path.join(this.repoLocation.uri.fsPath, `main.py`), '-tests', JSON.stringify(testList)], 
        {
            env: this.getEnvironment(),
            cwd: this.repoLocation.uri.fsPath
        });

        return new TestOutputScanner(runMain, undefined);
    }

    public async debug(baseArgs: ReadonlyArray<string>, filter?: ReadonlyArray<vscode.TestItem>) {
        const server = this.createWaitServer();

        const testList = getTestIDsFromTestItemTree(filter);

        const pythonApi: PythonExtension = await PythonExtension.api();
        const environmentPath = pythonApi.environments.getActiveEnvironmentPath();
        let debugCmd = await (await pythonApi.debug.getRemoteLauncherCommand(DEBUGPY_HOST, DEBUGPY_PORT, true))
        
        debugCmd = debugCmd.concat([
            path.join(this.repoLocation.uri.fsPath, `main.py`), 
            '-tests', JSON.stringify(testList)
        ])

        const debugMain = spawn(
                environmentPath.path,
                debugCmd, 
                {
                        env: this.getEnvironment(),
                        cwd: this.repoLocation.uri.fsPath,
                        stdio: 'pipe'
                }
        );
        // Debugpy's server needs a few seconds to setup before VSCode can attach. 
        // Could not find way to make VSCode dynamically wait until debugpy was ready.
        await new Promise(r => setTimeout(r, 1000));

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
        vscode.debug.startDebugging(this.repoLocation, pythonDebug);

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
            PYDEVD_DISABLE_FILE_VALIDATION: '1',
            PYTHONUNBUFFERED: '1'
        };
    }

    // protected abstract getDefaultArgs(): string[];

    // protected abstract binaryPath(): Promise<string>;

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
