/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import {
    GREATEST_LOWER_BOUND,
    LEAST_UPPER_BOUND,
    originalPositionFor,
    TraceMap,
} from '@jridgewell/trace-mapping';
import styles from 'ansi-styles';
import { ChildProcessWithoutNullStreams } from 'child_process';
import { decode as base64Decode } from 'js-base64';
import * as split from 'split2';
import * as vscode from 'vscode';
import { TestMessage } from 'vscode';
import { attachTestMessageMetadata } from './metadata';
import { snapshotComment } from './snapshot';
import { getContentFromFilesystem } from './testTree';

export const enum KTAutoEvent {
    SuiteStart = 'suiteStart',
    TestStart = 'testStart',
    TestEvent = 'testEvent',
    TestStop = 'testStop',
    SuiteEnd = 'suiteStop',
  }

export const enum KTEventStatus {
    NOT_SET = 0,
    RETRYING = 2,
    SUCCESS = 3,
    RETRY_SUCCESS = 5,
    FAILED = 6,
    FAILED_TIMEOUT = 7
}

export const enum KTTestResult {
    NOT_RAN = 0,
    PASSED = 1,
    SOFT_VERIFICATION_FAILURE = 2,
    HARD_VERIFICATION_FAILURE = 3,
    KNOWN_FAILURE_FAIL = 4,
    KNOWN_FAILURE_PASSED = 5,
    UNEXPECTED_ERROR = 6,
    CLEANUP_FAILURE_FAIL = 7,
    CLEANUP_FAILURE_PASS = 8
}

export interface KTException {
    msg: string;
    screen: string;
    stracktrace: string[];
}

export interface IKTTestEvent {
    _name: string;
    _log_msg: { _msg_list: string[] };
    _event_type: number;
    _status: number;
    _attempts: number;
    _execution_time: number;
    _start_time: number;
    _exceptions: KTException[];
    _request: string;
    _return_values: string[]
  }


export type KTEventTuple =
    | [string, IKTTestEvent]
    | [KTAutoEvent.SuiteStart, IKTTestEvent];



export const enum MochaEvent {
    Start = 'start',
    TestStart = 'testStart',
    Pass = 'pass',
    Fail = 'fail',
    End = 'end',
}

export interface IStartEvent {
    total: number;
}

export interface ITestStartEvent {
    title: string;
    fullTitle: string;
    file: string;
    currentRetry: number;
    speed: string;
}



export interface IPassEvent extends ITestStartEvent {
    duration: number;
}

export interface IFailEvent extends IPassEvent {
    err: string;
    stack: string | null;
    expected?: string;
    actual?: string;
    expectedJSON?: unknown;
    actualJSON?: unknown;
    snapshotPath?: string;
    }

export interface IEndEvent {
    suites: number;
    tests: number;
    passes: number;
    pending: number;
    failures: number;
    start: string /* ISO date */;
    end: string /* ISO date */;
}

export type MochaEventTuple =
  | [MochaEvent.Start, IStartEvent]
  | [MochaEvent.TestStart, ITestStartEvent]
  | [MochaEvent.Pass, IPassEvent]
  | [MochaEvent.Fail, IFailEvent]
  | [MochaEvent.End, IEndEvent];

export class TestOutputScanner implements vscode.Disposable {
    protected mochaEventEmitter = new vscode.EventEmitter<MochaEventTuple>();
    protected ktAutoEventEmitter = new vscode.EventEmitter<KTEventTuple>();
    protected outputEventEmitter = new vscode.EventEmitter<string>();
    protected onErrorEmitter = new vscode.EventEmitter<string>();

    /**
     * Fired when a KT Automation event comes in.
     */
    public readonly onKTAutoEvent = this.ktAutoEventEmitter.event;

    /**
     * Fired when a mocha event comes in.
     */
    public readonly onMochaEvent = this.mochaEventEmitter.event;

    /**
     * Fired when other output from the process comes in.
     */
    public readonly onOtherOutput = this.outputEventEmitter.event;

    /**
     * Fired when the process encounters an error, or exits.
     */
    public readonly onRunnerError = this.onErrorEmitter.event;

    constructor(private readonly process: ChildProcessWithoutNullStreams, private args?: string[]) {
        process.stdout.pipe(split()).on('data', this.processData);
        process.stderr.pipe(split()).on('data', this.processData);
        process.on('error', e => this.onErrorEmitter.fire(e.message));
        process.on('exit', code => this.onErrorEmitter.fire(`Test process exited with code ${code}`));
    }

    /**
     * @override
     */
    public dispose() {
        try {
            this.process.kill();
        } catch {
            // ignored
        }
    }

    protected readonly processData = (data: string) => {

        try {
            const parsed = JSON.parse(data);
            console.log(parsed)
            if (parsed instanceof Array && parsed.length === 2 && typeof parsed[0] === 'string') {
                this.ktAutoEventEmitter.fire(parsed as KTEventTuple)
            } else {
                this.outputEventEmitter.fire(data);
            }
        } catch(e) {
            this.outputEventEmitter.fire(data);
        }
    };
    }

    type QueuedOutput = string | [string, vscode.Location | undefined, vscode.TestItem | undefined];

    export async function scanTestOutput(
    tests: Map<string, vscode.TestItem>,
    task: vscode.TestRun,
    scanner: TestOutputScanner,
    cancellation: vscode.CancellationToken
    ): Promise<void> {
    const exitBlockers: Set<Promise<unknown>> = new Set();
    const skippedTests = new Set(tests.values());
    const store = new SourceMapStore();
    let outputQueue = Promise.resolve();
    const enqueueOutput = (fn: QueuedOutput | (() => Promise<QueuedOutput>)) => {
        exitBlockers.delete(outputQueue);
        outputQueue = outputQueue.finally(async () => {
        const r = typeof fn === 'function' ? await fn() : fn;
        typeof r === 'string' ? task.appendOutput(r) : task.appendOutput(...r);
        });
        exitBlockers.add(outputQueue);
        return outputQueue;
    };
    const enqueueExitBlocker = <T>(prom: Promise<T>): Promise<T> => {
        exitBlockers.add(prom);
        prom.finally(() => exitBlockers.delete(prom));
        return prom;
    };

    let lastTest: vscode.TestItem | undefined;
    let ranAnyTest = false;

    try {
        if (cancellation.isCancellationRequested) {
            return;
        }

        await new Promise<void>(resolve => {
        cancellation.onCancellationRequested(() => {
            resolve();
        });

        let currentTest: vscode.TestItem | undefined;

        scanner.onRunnerError(err => {
            enqueueOutput(err + crlf);
            resolve();
        });

        scanner.onOtherOutput(str => {
            const tItem = tests.get('DOTNETMC_T224')

            if (tItem) {
                try {
                    skippedTests.delete(tItem);
                } catch {
                    
                }
                task.passed(tItem, 1000)
            }
            const match = spdlogRe.exec(str);
            if (!match) {
                enqueueOutput(str + crlf);
                return;
            }

            const logLocation = store.getSourceLocation(match[2], Number(match[3]));
            const logContents = replaceAllLocations(store, match[1]);
            const test = currentTest;

            enqueueOutput(() =>
            Promise.all([logLocation, logContents]).then(([location, contents]) => [
                contents + crlf,
                location,
                test,
            ])
            );
        });

        scanner.onKTAutoEvent(evt => {
            const testId = evt[0]
            const eventData = evt[1]
            const tItem = tests.get(testId)

            // ` ${styles.green.open}√${styles.green.close} ${title}\r\n`
            const logPrefix = `${styles.blueBright.open}[${testId}]${styles.blueBright.close} `;
            let stepPrefix = ` `;
            let spacer = '     ';
            for (let index = 0; index < testId.length; index++) {
                spacer += ' '
            }

            if (tItem) {
                switch (eventData._event_type) {
                    case 32: // TEST_RUN_START
                        skippedTests.delete(tItem);
                        task.started(tItem);
                        break;
                    case 33: // TEST_RUN_END
                        const [testStatus, executionTime] = JSON.parse(eventData._return_values[0])
                        if (testStatus == KTTestResult.PASSED) {
                            task.passed(tItem, executionTime);
                        } else {
                            task.failed(tItem, new TestMessage('Test Failed'), executionTime);
                        }
                        return;
                    case 34: // STEP_START
                        stepPrefix = `${styles.bgWhite.open}↳${styles.bgWhite.close}`;
                        break;
                    case 30: // ERROR
                        return;
                }

                if (eventData._status == 6 || eventData._status == 7) {
                    stepPrefix = `${styles.whiteBright.open}${styles.bgRed.open}X${styles.bgRed.close}${styles.whiteBright.close}`;
                }

                // Standard Log
                task.appendOutput(logPrefix + stepPrefix + ` ` + eventData._log_msg._msg_list[0] + `  ${eventData._event_type}-${eventData._status}` + crlf);

                // Log Exception msg if event failed
                if (eventData._status == 6 || eventData._status == 7) {
                    task.appendOutput(spacer + eventData._exceptions[0].msg + crlf);
                }

                // Log additional lines
                if (eventData._log_msg._msg_list.length > 1) {
                    for (let i = 1; i < eventData._log_msg._msg_list.length; i++) {
                        task.appendOutput(spacer + stepPrefix + ` ` + eventData._log_msg._msg_list[i] + crlf);
                    }
                }

                // if (eventData._event_type == 33) { 
                //     const parsed = JSON.parse(eventData._return_values[0]);

                //     if (parsed[0] == 1) {
                //         task.passed(tItem, parsed[1])
                //     } else {
                //         const msg = new TestMessage('Test Failed');
                //         task.failed(tItem, msg, parsed[1])
                //     }

                // }
            }

            // const match = spdlogRe.exec(eventData._request);
            // if (!match) {
            //     // enqueueOutput(eventData._request + crlf);
            //     return;
            // }
        })

        scanner.onMochaEvent(evt => {
            switch (evt[0]) {
            case MochaEvent.Start:
                break; // no-op
            case MochaEvent.TestStart:
                currentTest = tests.get(evt[1].fullTitle)!;
                skippedTests.delete(currentTest);
                task.started(currentTest);
                ranAnyTest = true;
                break;
            case MochaEvent.Pass:
                {
                const title = evt[1].fullTitle;
                const tcase = tests.get(title);
                enqueueOutput(` ${styles.green.open}√${styles.green.close} ${title}\r\n`);
                if (tcase) {
                    lastTest = tcase;
                    task.passed(tcase, evt[1].duration);
                    tests.delete(title);
                }
                }
                break;
            case MochaEvent.Fail:
                {
                const {
                    err,
                    stack,
                    duration,
                    expected,
                    expectedJSON,
                    actual,
                    actualJSON,
                    snapshotPath,
                    fullTitle: id,
                } = evt[1];
                let tcase = tests.get(id);
                // report failures on hook to the last-seen test, or first test if none run yet
                if (!tcase && id.includes('hook for')) {
                    tcase = lastTest ?? tests.values().next().value;
                }

                enqueueOutput(`${styles.red.open} x ${id}${styles.red.close}\r\n`);
                const rawErr = stack || err;
                const locationsReplaced = replaceAllLocations(store, forceCRLF(rawErr));
                if (rawErr) {
                    enqueueOutput(async () => [await locationsReplaced, undefined, tcase]);
                }

                if (!tcase) {
                    return;
                }

                tests.delete(id);

                const hasDiff =
                    actual !== undefined &&
                    expected !== undefined &&
                    (expected !== '[undefined]' || actual !== '[undefined]');
                const testFirstLine =
                    tcase.range &&
                    new vscode.Location(
                    tcase.uri!,
                    new vscode.Range(
                        tcase.range.start,
                        new vscode.Position(tcase.range.start.line, 100)
                    )
                    );

                enqueueExitBlocker(
                    (async () => {
                    const location = await tryDeriveStackLocation(store, rawErr, tcase!);
                    let message: vscode.TestMessage;

                    if (hasDiff) {
                        message = new vscode.TestMessage(tryMakeMarkdown(err));
                        message.actualOutput = outputToString(actual);
                        message.expectedOutput = outputToString(expected);
                        if (snapshotPath) {
                        message.contextValue = 'isSelfhostSnapshotMessage';
                        message.expectedOutput += snapshotComment + snapshotPath;
                        }

                        attachTestMessageMetadata(message, {
                        expectedValue: expectedJSON,
                        actualValue: actualJSON,
                        });
                    } else {
                        message = new vscode.TestMessage(
                        stack ? await sourcemapStack(store, stack) : await locationsReplaced
                        );
                    }

                    message.location = location ?? testFirstLine;
                    task.failed(tcase!, message, duration);
                    })()
                );
                }
                break;
            case MochaEvent.End:
                resolve();
                break;
            }
        });
        });
        await Promise.all([...exitBlockers]);

        // no tests? Possible crash, show output:
        if (!ranAnyTest) {
        await vscode.commands.executeCommand('testing.showMostRecentOutput');
        }
    } catch (e) {
        task.appendOutput((e as Error).stack || (e as Error).message);
    } finally {
        scanner.dispose();
        for (const test of skippedTests) {
            task.skipped(test);
        }
        task.end();
    }
}

const spdlogRe = /"(.+)", source: (file:\/\/\/.*?)+ \(([0-9]+)\)/;
const crlf = '\r\n';

const forceCRLF = (str: string) => str.replace(/(?<!\r)\n/gm, '\r\n');

const sourcemapStack = async (store: SourceMapStore, str: string) => {
  locationRe.lastIndex = 0;

  const replacements = await Promise.all(
    [...str.matchAll(locationRe)].map(async match => {
      const location = await deriveSourceLocation(store, match);
      if (!location) {
        return;
      }
      return {
        from: match[0],
        to: location?.uri.with({
          fragment: `L${location.range.start.line + 1}:${location.range.start.character + 1}`,
        }),
      };
    })
  );

  for (const replacement of replacements) {
    if (replacement) {
      str = str.replace(replacement.from, replacement.to.toString(true));
    }
  }

  return str;
};

const outputToString = (output: unknown) =>
  typeof output === 'object' ? JSON.stringify(output, null, 2) : String(output);

const tryMakeMarkdown = (message: string) => {
  const lines = message.split('\n');
  const start = lines.findIndex(l => l.includes('+ actual'));
  if (start === -1) {
    return message;
  }

  lines.splice(start, 1, '```diff');
  lines.push('```');
  return new vscode.MarkdownString(lines.join('\n'));
};

const inlineSourcemapRe = /^\/\/# sourceMappingURL=data:application\/json;base64,(.+)/m;
const sourceMapBiases = [GREATEST_LOWER_BOUND, LEAST_UPPER_BOUND] as const;

class SourceMapStore {
  private readonly cache = new Map</* file uri */ string, Promise<TraceMap | undefined>>();

  async getSourceLocation(fileUri: string, line: number, col = 1) {
    const sourceMap = await this.loadSourceMap(fileUri);
    if (!sourceMap) {
      return undefined;
    }

    for (const bias of sourceMapBiases) {
      const position = originalPositionFor(sourceMap, { column: col - 1, line: line, bias });
      if (position.line !== null && position.column !== null && position.source !== null) {
        return new vscode.Location(
          vscode.Uri.parse(position.source),
          new vscode.Position(position.line - 1, position.column)
        );
      }
    }

    return undefined;
  }

  private loadSourceMap(fileUri: string) {
    const existing = this.cache.get(fileUri);
    if (existing) {
      return existing;
    }

    const promise = (async () => {
      try {
        const contents = await getContentFromFilesystem(vscode.Uri.parse(fileUri));
        const sourcemapMatch = inlineSourcemapRe.exec(contents);
        if (!sourcemapMatch) {
          return;
        }

        const decoded = base64Decode(sourcemapMatch[1]);
        return new TraceMap(decoded, fileUri);
      } catch (e) {
        console.warn(`Error parsing sourcemap for ${fileUri}: ${(e as Error).stack}`);
        return;
      }
    })();

    this.cache.set(fileUri, promise);
    return promise;
  }
}

const locationRe = /(file:\/{3}.+):([0-9]+):([0-9]+)/g;

async function replaceAllLocations(store: SourceMapStore, str: string) {
  const output: (string | Promise<string>)[] = [];
  let lastIndex = 0;

  for (const match of str.matchAll(locationRe)) {
    const locationPromise = deriveSourceLocation(store, match);
    const startIndex = match.index || 0;
    const endIndex = startIndex + match[0].length;

    if (startIndex > lastIndex) {
      output.push(str.substring(lastIndex, startIndex));
    }

    output.push(
      locationPromise.then(location =>
        location
          ? `${location.uri}:${location.range.start.line + 1}:${location.range.start.character + 1}`
          : match[0]
      )
    );

    lastIndex = endIndex;
  }

  // Preserve the remaining string after the last match
  if (lastIndex < str.length) {
    output.push(str.substring(lastIndex));
  }

  const values = await Promise.all(output);
  return values.join('');
}

async function tryDeriveStackLocation(
  store: SourceMapStore,
  stack: string,
  tcase: vscode.TestItem
) {
  locationRe.lastIndex = 0;

  return new Promise<vscode.Location | undefined>(resolve => {
    const matches = [...stack.matchAll(locationRe)];
    let todo = matches.length;
    if (todo === 0) {
      return resolve(undefined);
    }

    let best: undefined | { location: vscode.Location; i: number; score: number };
    for (const [i, match] of matches.entries()) {
      deriveSourceLocation(store, match)
        .catch(() => undefined)
        .then(location => {
          if (location) {
            let score = 0;
            if (tcase.uri && tcase.uri.toString() === location.uri.toString()) {
              score = 1;
              if (tcase.range && tcase.range.contains(location?.range)) {
                score = 2;
              }
            }
            if (!best || score > best.score || (score === best.score && i < best.i)) {
              best = { location, i, score };
            }
          }

          if (!--todo) {
            resolve(best?.location);
          }
        });
    }
  });
}

async function deriveSourceLocation(store: SourceMapStore, parts: RegExpMatchArray) {
  const [, fileUri, line, col] = parts;
  return store.getSourceLocation(fileUri, Number(line), Number(col));
}
