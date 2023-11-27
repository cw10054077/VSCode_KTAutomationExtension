/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as PyParser from '@qoretechnologies/python-parser';
import { TextDecoder } from 'util';
import * as vscode from 'vscode';

const textDecoder = new TextDecoder('utf-8');
const diagnosticCollection = vscode.languages.createDiagnosticCollection('selfhostTestProvider');

type ContentGetter = (uri: vscode.Uri) => Promise<string>;

/**
 * A flat array of elements (no nested elements) representing all nodes displayed in the testing tree view, 
 * where each Test Item is mapped to a custom VSCodeTest object.
 * Used to provide additional information for each Test Item and define if it is a {@linkcode TestSuite}, {@linkcode TestFile}, or {@linkcode TestCase}
 */
export const itemData = new WeakMap<vscode.TestItem, VSCodeTest>();

export const clearFileDiagnostics = (uri: vscode.Uri) => diagnosticCollection.delete(uri);

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

/**
 * Tries to guess which workspace folder VS Code is in.
 */
export const guessWorkspaceFolder = async () => {
    if (!vscode.workspace.workspaceFolders) {
        return undefined;
    }

    if (vscode.workspace.workspaceFolders.length < 2) {
        return vscode.workspace.workspaceFolders[0];
    }

    for (const folder of vscode.workspace.workspaceFolders) {
        try {
            await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder.uri, 'src/vs/loader.js'));
            return folder;
        } catch {
            // ignored
        }
    }

    return undefined;
};

export const getContentFromFilesystem: ContentGetter = async uri => {
    try {
        const rawContent = await vscode.workspace.fs.readFile(uri);
        return textDecoder.decode(rawContent);
    } catch (e) {
        console.warn(`Error providing tests for ${uri.fsPath}`, e);
        return '';
    }
};

export const buildTree = async (controller: vscode.TestController, dir:vscode.Uri): Promise<vscode.TestItem> => {

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(dir);
  
    // Create TestItem/TestSuite to represent the directory we are searching within
    const dirName = dir.path.split('/').pop()!;
    const newSuite = new TestSuite(dirName)
    const item = createTestItemData(controller, dir.fsPath, dirName, dir, newSuite);
    item.canResolveChildren = true;
  
    // Iterate through all folders and files found within this directory
    for (const dirItem of await vscode.workspace.fs.readDirectory(dir)) {
  
        // Folder
        if (dirItem[1] == vscode.FileType.Directory && !dirItem[0].includes('pycache') && !dirItem[0].includes('AppObjects')) {
            // Recursively call buildTree again to find items with this folder.
            // Add the returned TestItem (Suite) as a child of the main TestItem
            item.children.add(await buildTree(controller, vscode.Uri.joinPath(dir, dirItem[0])))
        }
  
        // File
        if (dirItem[1] == vscode.FileType.File && !dirItem[0].startsWith('_') && !dirItem[0].startsWith('.')) {
    
            // Create TestFile
            const testDir = vscode.Uri.joinPath(dir, dirItem[0]);
            const testFile = new TestFile(testDir, workspaceFolder);
    
            // Create TestItem/TestFile to represent the test file.
            const testItem = createTestItemData(controller, testDir.fsPath, dirItem[0], testDir, testFile);
            testItem.canResolveChildren = true;
    
            // call UpdateFromDisk to add test cases to TestItem 
            testFile.updateFromDisk(controller, testItem);
    
            // Add the TestItem to the parent TestSuite we are iterating through.
            item.children.add(testItem)
        }
  
    }
  
    return item;
}

export class TestFile {
    public hasBeenRead = false;

    constructor(
        public readonly uri: vscode.Uri,
        public readonly workspaceFolder?: vscode.WorkspaceFolder
    ) {}

    public getId() {
        return this.uri.toString().toLowerCase();
    }

    public getLabel() {
        return this.uri.fsPath.split('/').pop() || '';
    }

    public async updateFromDisk(controller: vscode.TestController, item: vscode.TestItem) {
        try {
            const content = await getContentFromFilesystem(item.uri!);
            item.error = undefined;
            this.updateFromContents(controller, content, item);
        } catch (e) {
            item.error = (e as Error).stack;
        }
    }

    /**
     * Refreshes all tests in this file, `sourceReader` provided by the root.
     */
    public updateFromContents(
        controller: vscode.TestController,
        content: string,
        file: vscode.TestItem
    ):PyParser.Class[] | undefined {
        try {

            // Parse raw python source into a representation of it's classes, methods, etc.
            const pythonTree = PyParser.parse(content)

            // Find nodes that are classes and extend the class TestCase
            // The highlighted error says that type cannot be 'arg', but the error is incorrect.
            const pythonArray: PyParser.Class[] = PyParser.walk(pythonTree)
                // @ts-expect-error
                .filter(node => (node.type == 'class' && node.extends[0].type == 'arg' && node.extends[0].actual.id == 'TestCase'))
                .map(node => { return node as PyParser.Class });

            // Iterate through each test method in this file's content and add as child to the Test Item (Test File)
            pythonArray.forEach(node => {
                const correctedFirstLine = node.location?.first_line === undefined ? 1 : node.location.first_line - 1;
                const range = new vscode.Range(
                    new vscode.Position(correctedFirstLine, node.location?.first_column ?? 0),
                    new vscode.Position(node.location?.last_line ?? 1, node.location?.last_column ?? 1 < 0 ? 1 : node.location?.last_column ?? 1)
                );

                // Create the TestCase for the test class.
                const testCase = new TestCase(node.name, range, itemData.get(file) as TestConstruct);

                // Create the Testitem and add the TestItem/TestCase to itemData.
                const item = createTestItemData(controller, node.name, node.name, file.uri, testCase);
                item.range = range;

                // Add the Testitem to the file's TestItem's children.
                file.children.add(item);
            });

            file.error = undefined;
            this.hasBeenRead = true;

            return pythonArray;
        } catch (e) {
            file.error = String((e as Error).stack || (e as Error).message);
        }
        return undefined;
    }
}

export abstract class TestConstruct {
    public fullName: string;

    constructor(
        public readonly name: string,
        public readonly range?: vscode.Range,
        parent?: TestConstruct
    ) {
        this.fullName = name;
        // console.log(parent);
        // this.fullName = parent ? `${parent.fullName} ${name}` : name;
    }
}

export class TestSuite extends TestConstruct {}

export class TestCase extends TestConstruct {}

export type VSCodeTest = TestFile | TestSuite | TestCase;
