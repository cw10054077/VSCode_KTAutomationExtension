/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import { FrameworkConfiguration, TestConfigViewProvider } from './configWebView';
import { FailingDeepStrictEqualAssertFixer } from './failingDeepStrictEqualAssertFixer';
import { registerSnapshotUpdate } from './snapshot';
import { scanTestOutput } from './testOutputScanner';
import {
    TestCase,
    TestFile,
    TestSuite,
    VSCodeTest,
    buildTree,
    clearFileDiagnostics,
    guessWorkspaceFolder,
    itemData,
} from './testTree';
import { VSCodeTestRunner } from './vscodeTestRunner';

const TEST_FOLDER = '_TestItem'
const TEST_FILE_PATTERN = '_TestItem/TestCases/**/*.py';

// Return the WorkspaceFolder of the project for a given test file.
// const getWorkspaceFolderForTestFile = (uri: vscode.Uri) =>
//     (uri.path.endsWith('.py') && uri.path.includes(TEST_FOLDER))
//         ? vscode.workspace.getWorkspaceFolder(uri)
//         : undefined;

type FileChangeEvent = { uri: vscode.Uri; removed: boolean };

export async function testSnippet() {
    const insertLocation = new vscode.Range(2, 0, 3, 0);
    const snipper = new vscode.SnippetString('snippet string');

    // vscode.window.showOpenDialog(undefined)
    
    // Inserts text into the document
    vscode.window.activeTextEditor?.insertSnippet(snipper, insertLocation);

}

export const frameworkConfigValues = new FrameworkConfiguration();

// function replyNote(reply: vscode.CommentReply) {
//     const thread = reply.thread;
//     const newComment = new NoteComment(reply.text, vscode.CommentMode.Preview, { name: 'vscode' }, thread, thread.comments.length ? 'canDelete' : undefined);
//     if (thread.contextValue === 'draft') {
//         newComment.label = 'pending';
//     }

//     thread.comments = [...thread.comments, newComment];
// }


// Primary method that executes when extension is activated. Will only be ran once (per session).
// Extensions can be activated by conditions set in package.json under "activationEvents".
// "*" will cause extension to activate on startup.
export async function activate(context: vscode.ExtensionContext) {

    // Web View 

    const webViewProvider = new TestConfigViewProvider(context.extensionUri);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(TestConfigViewProvider.viewType, webViewProvider)
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('calicoColors.addColor', () => {
            webViewProvider.addColor();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('calicoColors.clearColors', () => {
            webViewProvider.clearColors();
        })
    );

    // /Web View

    // TEST COMMENTS

    // const commentCtrl = vscode.comments.createCommentController('test-commenter', 'Comment Tests with Test Info');
    // context.subscriptions.push(commentCtrl);

    // commentCtrl.commentingRangeProvider = {
    //     provideCommentingRanges: (document: vscode.TextDocument, token: vscode.CancellationToken) => {
    //         const lineCount = document.lineCount;
    //         return [new vscode.Range(0, 0, lineCount - 1, 0)];
    //     }
    // }

    // context.subscriptions.push(vscode.commands.registerCommand('testnotes.createNote', (reply: vscode.CommentReply) => {
    //     replyNote(reply);
    // }));

	// context.subscriptions.push(vscode.commands.registerCommand('testnotes.saveNote', (comment: NoteComment) => {
	// 	if (!comment.parent) {
	// 		return;
	// 	}

	// 	comment.parent.comments = comment.parent.comments.map(cmt => {
	// 		if ((cmt as NoteComment).id === comment.id) {
	// 			(cmt as NoteComment).savedBody = cmt.body;
	// 			cmt.mode = vscode.CommentMode.Preview;
	// 		}

	// 		return cmt;
	// 	});
	// }));

    // context.subscriptions.push(vscode.commands.registerCommand('testnotes.dispose', () => {
	// 	commentCtrl.dispose();
	// }));


    // testCmt.state

    
    // /TEST COMMENTS

    // Register a defined function (testSnippet()) to a vscode command (extension.testSnippet)
    // context.subscriptions.push(
    //     vscode.commands.registerCommand("extension.testSnippet", testSnippet)
    // )

    // CODE LENS

    // const sel: DocumentSelector = { scheme: 'file', language: 'python' };
    // context.subscriptions.push(
    //     vscode.languages.registerCodeLensProvider(
    //         sel, new GoCodeLensProvider()));

    // CODE LENS

    // Create Test Controller. Main object to handle test extension
    const ctrl = vscode.tests.createTestController('selfhost-test-controller', 'VS Code Tests');
    const fileChangedEmitter = new vscode.EventEmitter<FileChangeEvent>();
    const workspaceFolder = await guessWorkspaceFolder();

    // Recursively iterate through all test subfolders to build test tree
    ctrl.items.add(await buildTree(ctrl, vscode.Uri.joinPath(workspaceFolder!.uri, TEST_FOLDER)));

    // Define the Test Controller's 'resolveHandler' method.
    // Used to occasionally refresh the test hierarchy view (all the items listed in the 'Beaker' tab).
    // The 'test' parameter will either be a 'Test Item' (any item in the testing view, including folders, test files, and test methods)
    //   or undefined if initializing the list.
    ctrl.resolveHandler = async test => {

        // If 'test' is undefined, initialize workspace watcher.
        if (!test) {
            context.subscriptions.push(await startWatchingWorkspace(ctrl, fileChangedEmitter));
            return;
        }

        // If 'test' exists, get the associated VSCodeTest data (custom type defined in testTree.ts)
        // VSCodeTest: WeakMap<vscode.TestItem, TestSuite | TestFile | TestCase>();
        const data = itemData.get(test);

        // If we defined the given Test Item as a TestFile, then update the Test Item and it's children (Test Cases)
        if (data instanceof TestFile) {
            // No need to watch this, updates will be triggered on file changes
            // either by the text document or file watcher.
            await data.updateFromDisk(ctrl, test);
        }
    };

    let runQueue = Promise.resolve();
    const createRunHandler = (
        runnerCtor: { new (folder: vscode.WorkspaceFolder): VSCodeTestRunner },
        debug: boolean,
        args: string[] = []
    ) => {
        const doTestRun = async (
            req: vscode.TestRunRequest,
            cancellationToken: vscode.CancellationToken
        ) => {
            const folder = await guessWorkspaceFolder();
            if (!folder) {
                return;
            }

            const runner = new runnerCtor(folder);
            const map = await getPendingTestMap(ctrl, req.include ?? gatherTestItems(ctrl.items));
            const task = ctrl.createTestRun(req);
            for (const test of map.values()) {
                task.enqueued(test);
            }

            return (runQueue = runQueue.then(async () => {
                await scanTestOutput(
                    map,
                    task,
                    debug ? await runner.debug(args, req.include) : await runner.run(args, req.include),
                    cancellationToken
                );
            }));
        };

        return async (req: vscode.TestRunRequest, cancellationToken: vscode.CancellationToken) => {
            if (!req.continuous) {
                return doTestRun(req, cancellationToken);
            }

            const queuedFiles = new Set<string>();
            let debounced: NodeJS.Timer | undefined;

            const listener = fileChangedEmitter.event(({ uri, removed }) => {
                clearTimeout(debounced);

                if (req.include && !req.include.some(i => i.uri?.toString() === uri.toString())) {
                    return;
                }

                if (removed) {
                    queuedFiles.delete(uri.toString());
                } else {
                    queuedFiles.add(uri.toString());
                }

                debounced = setTimeout(() => {
                    const include =
                        req.include?.filter(t => t.uri && queuedFiles.has(t.uri?.toString())) ??
                        [...queuedFiles]
                            .map(f => getOrCreateFile(ctrl, vscode.Uri.parse(f)))
                            .filter((f): f is vscode.TestItem => !!f);
                    queuedFiles.clear();

                    doTestRun(
                        new vscode.TestRunRequest(include, req.exclude, req.profile, true),
                        cancellationToken
                    );
                }, 1000);
            });

            cancellationToken.onCancellationRequested(() => {
                clearTimeout(debounced);
                listener.dispose();
            });
        };
    };

    ctrl.createRunProfile(
        'Run KT Python Framework',
        vscode.TestRunProfileKind.Run,
        createRunHandler(VSCodeTestRunner, false),
        true,
        undefined,
        true
    );

    ctrl.createRunProfile(
        'Debug KT Python Framework',
        vscode.TestRunProfileKind.Debug,
        createRunHandler(VSCodeTestRunner, true),
        true,
        undefined,
        true
    );

    // Get or generate TestFile for a given text document, then generate/update TestCases for that TestFile.
    function updateNodeForDocument(e: vscode.TextDocument) {
        const node = getOrCreateFile(ctrl, e.uri);
        const data = node && itemData.get(node);
        // let testNodes: PyParser.Class[] | undefined;
        if (data instanceof TestFile) {
            data.updateFromContents(ctrl, e.getText(), node!);
        }
        // TEST COMMENTS
        // if (testNodes != undefined) {
        //     generateTestStepComment(commentCtrl, e, testNodes);
        // }
    }

    // Update Test Tree for any currently open documents.
    for (const document of vscode.workspace.textDocuments) {
        updateNodeForDocument(document);
    }

    // Add the test controller and functions used to handle documents opening/changing to
    //     the extensions subscriptions. 
    context.subscriptions.push(
        ctrl,
        fileChangedEmitter.event(({ uri, removed }) => {
            if (!removed) {
                const node = getOrCreateFile(ctrl, uri);
                if (node) {
                    ctrl.invalidateTestResults();
                }
            }
        }),
        vscode.workspace.onDidOpenTextDocument(updateNodeForDocument),
        vscode.workspace.onDidChangeTextDocument(e => updateNodeForDocument(e.document)),
        registerSnapshotUpdate(ctrl),
        new FailingDeepStrictEqualAssertFixer()
    );

}

export function deactivate() {
    // no-op
}

function getOrCreateFile(
    controller: vscode.TestController,
    uri: vscode.Uri
): vscode.TestItem | undefined {

    // Determine if item is within the test folder (excluding python system files)
    const fileOrFolderName = uri.fsPath.split('/').pop()!;
    if (!uri.fsPath.includes(TEST_FOLDER + '/') || 
        fileOrFolderName.includes('__') || 
        fileOrFolderName.endsWith('pyc') ||
        uri.fsPath.includes('AppObjects')) {
        return undefined;
    }
    
    // getWorkspaceFolder will return undefined for certain files such as .git
    //    without us having to check for them manually.
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) {
        return undefined;
    }

    // Find or create TestItem for this file and return it.
    const relativePath = uri.fsPath.replace(folder.uri.fsPath, '').substring(1);
    const data = new TestFile(uri, folder);
    return getOrCreateNestedTestItem(controller, data, controller.items, relativePath.split('/'));
}

function gatherTestItems(collection: vscode.TestItemCollection) {
    const items: vscode.TestItem[] = [];
    collection.forEach(item => items.push(item));
    return items;
}

async function startWatchingWorkspace(
    controller: vscode.TestController,
    fileChangedEmitter: vscode.EventEmitter<FileChangeEvent>
) {
    const workspaceFolder = await guessWorkspaceFolder();
    if (!workspaceFolder) {
        return new vscode.Disposable(() => undefined);
    }

    const pattern = new vscode.RelativePattern(workspaceFolder, TEST_FILE_PATTERN);
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);

    watcher.onDidCreate(uri => {
        getOrCreateFile(controller, uri);
        fileChangedEmitter.fire({ removed: false, uri });
    });
    watcher.onDidChange(uri => fileChangedEmitter.fire({ removed: false, uri }));
    watcher.onDidDelete(uri => {
        fileChangedEmitter.fire({ removed: true, uri });
        clearFileDiagnostics(uri);
        controller.items.delete(uri.toString());
    });

    for (const file of await vscode.workspace.findFiles(pattern)) {
        getOrCreateFile(controller, file);
    }

    return watcher;
}

async function getPendingTestMap(ctrl: vscode.TestController, tests: Iterable<vscode.TestItem>) {
    const queue = [tests];
    const titleMap = new Map<string, vscode.TestItem>();
    while (queue.length) {
        for (const item of queue.pop()!) {
            const data = itemData.get(item);
            if (data instanceof TestFile) {
                if (!data.hasBeenRead) {
                    await data.updateFromDisk(ctrl, item);
                }
                queue.push(gatherTestItems(item.children));
            } else if (data instanceof TestCase) {
                titleMap.set(data.fullName, item);
            } else {
                queue.push(gatherTestItems(item.children));
            }
        }
    }

    return titleMap;
}

/**
 * Wrapper function for the controller's createTestItem. Adds provided VSCodeTest to map for new TestItems.
 * @param ctrl 
 * @param id 
 * @param label 
 * @param uri 
 * @param testItemData A TestFile, TestCase, or TestSuite to be associated with the 
 * TestItem being created
 * @returns The created TestItem
 */
export const createTestItemData = (ctrl: vscode.TestController, id: string, label: string, uri: vscode.Uri | undefined, testItemData: VSCodeTest): vscode.TestItem => {
    const testItem = ctrl.createTestItem(id, label, uri);
    itemData.set(testItem, testItemData);
    return testItem;
};

const getRegexOfGlobPattern = (pattern: string): string => {
    return pattern.replace('*', '\\w+').replace('.', '[.]');
};

/**
 * Given a TestFile based on a Python module, determine if that TestItem exists within our controller's TestItem tree. If not,
 *    create and place that TestItem within the tree.
 * 
 * @param ctrl 
 * @param testFile 
 * @param testItemCollection Either controller.items or any TestItems children
 * @param relativePathAry An array defining the directories between the workspace folder and the TestFile. 
 * 
 * @example
 * ```ts
 * const relativePath = uri.fsPath.replace(folder.uri.fsPath, '').substring(1);
 * const data = new TestFile(uri, folder);
 * return getOrCreateNestedTestItem(controller, data, controller.items, relativePath.split('/')
 * ```
 * @returns The existing TestItem within the tree, or a newly created TestItem.
 */
function getOrCreateNestedTestItem(ctrl: vscode.TestController, testFile: TestFile, testItemCollection: vscode.TestItemCollection, relativePathAry: string[]): vscode.TestItem {
  
    // ** GET FILE **
  
    // Iterate through TestItems in the collection and find item with matching label to current element in path array.
    // [id: string, testItem: vscode.TestItem]
    for (const i of testItemCollection) {
        if (i[1].label == relativePathAry[0]) {
        
            // If this is the last element in the array, then we have found the TestItem for this file.
            if(relativePathAry.length == 1) {
                return i[1];

            // If there are still elements left in the array, then we have found an existing TestSuite that the TestItem/File
            //    is contained within.
            } else {
                // Remove the matching element from the relativePathAry
                const adjustedAry = relativePathAry.slice(1, relativePathAry.length);
                // Recurse into method with shortened array and the children of the existing TestSuite.
                return getOrCreateNestedTestItem(ctrl, testFile, i[1].children, adjustedAry);
            }
        } 
    }
  
    // ** CREATE FILE **
  
    // If there was no matching TestItem within the collection and there are still elements left in the path array, 
    //    then create a TestSuite TestItem for this element.
    if(relativePathAry.length > 1) {
        // Generate TestSuite based on TestFile's path and our current position in relative path
        const suite = new TestSuite(relativePathAry[0]);
        const suitePathIndex = testFile.getId().indexOf(relativePathAry[0]);
        const suitePath = testFile.getId().substring(0, suitePathIndex + relativePathAry[0].length);
    
        // Add TestItem/TestSuite to collection
        const newTestItemSuite = createTestItemData(ctrl, suitePath, relativePathAry[0], vscode.Uri.parse(suitePath), suite);
        newTestItemSuite.canResolveChildren = true;
        testItemCollection.add(newTestItemSuite);
    
        // Remove first element of relativePathAry and recurse
        return getOrCreateNestedTestItem(ctrl, testFile, testItemCollection.get(suitePath)!.children, relativePathAry.slice(1, relativePathAry.length));
  
    // If there are no more elements in path array, then we have not found the file and should create a new TestItem for it.
    } else {
  
        // If new TestItem is a test file, create and return new TestItem/TestFile
        const regex = getRegexOfGlobPattern('*.py');
        const result = testFile.uri.path.search(regex);
        if (result > 0) {
            const newTestItem = createTestItemData(ctrl, testFile.getId(), testFile.getLabel(), testFile.uri, testFile);
            newTestItem.canResolveChildren = true;
            testItemCollection.add(newTestItem);
            return newTestItem;
        
        // Otherwise, create and return new TestItem/TestSuite
        } else {
            const suite = new TestSuite(relativePathAry[0]);
    
            // Add TestItem/TestSuite to collection
            const newTestItemSuite = createTestItemData(ctrl, testFile.getId(), testFile.getLabel(), testFile.uri, suite);
            newTestItemSuite.canResolveChildren = true;
            testItemCollection.add(newTestItemSuite);
            return newTestItemSuite;
        }
  
    }
  
}