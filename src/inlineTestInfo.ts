/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import * as PyParser from '@qoretechnologies/python-parser';
import * as vscode from 'vscode';
import { getTestSteps } from './services';

let commentId = 1;

export class NoteComment implements vscode.Comment {
    id: number;
    label?: string | undefined;
    savedBody: string | vscode.MarkdownString;

    constructor(
        public body: string | vscode.MarkdownString,
        public mode: vscode.CommentMode,
        public author: vscode.CommentAuthorInformation,
        public parent?: vscode.CommentThread,
        public contextValue?: string
    ) {
        this.id = ++commentId;
        this.savedBody = this.body;
    }
    
}

export async function generateTestStepComment(commentCtrl: vscode.CommentController, doc: vscode.TextDocument, testClasses: PyParser.Class[]) {

    for (const node of testClasses) {
        let line = node.location?.first_line ?? 0;
        if (line > 0) { line--; }
        const tempRange = new vscode.Range(line, 0, line, 0);
    
        await getTestSteps(node.name).then(testSteps => {
            let testStepString = '';
            for (const step of testSteps) {
                testStepString += step + '\r\n\r\n';
            }
            const cmt = new NoteComment(testStepString, vscode.CommentMode.Preview, { name: 'KT Automation Framework' })
        
            const testCmt = commentCtrl.createCommentThread(doc.uri, tempRange, [cmt])
            testCmt.canReply = false;
            testCmt.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
        });
        
    }
}

class testCommand implements vscode.Command {
    title: string;
    command: string;
    tooltip?: string | undefined;
    arguments?: any[] | undefined;

    constructor() {
        this.title =    'testCommand \r\n \
                        testCommand line 2 \r\n \r\n \
                        testCommand line 4';
        this.command = ''
        // this.command = 'extension.testSnippet'
        this.tooltip = 'test tooltip'
    }

}

export class GoCodeLensProvider implements vscode.CodeLensProvider {

    // Determines how many lenses should be provided for a given document (how many in-line notes to generate)
    public provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken):
        vscode.CodeLens[] | Thenable<vscode.CodeLens[]> {

            console.log(document);
            console.log(token);

            const range = new vscode.Range(
                new vscode.Position(1, 1),
                new vscode.Position(10, 1)
            );
            const range2 = new vscode.Range(
                new vscode.Position(1, 1),
                new vscode.Position(10, 1)
            );
            return [new vscode.CodeLens(range), new vscode.CodeLens(range2)];
    }

    // The in-line lens to be displayed in a document.
    public resolveCodeLens?(codeLens: vscode.CodeLens, token: vscode.CancellationToken):
         vscode.CodeLens | Thenable<vscode.CodeLens> {
            console.log(token);
            codeLens.command = new testCommand();
            return codeLens;
    }
}
