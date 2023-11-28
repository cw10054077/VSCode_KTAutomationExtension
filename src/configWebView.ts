/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import * as vscode from 'vscode';
import { frameworkConfigValues } from './extension';

export class FrameworkConfiguration {
    public suiteDefinitionID?: number;
    public environment: string;
    public browser: string;
    public num_parallel: number;
    public max_test_attempts: number;
    public max_event_attempts: number;
    public max_wait_time: number;
    public report_to_zephyr: boolean;
    public run_local: boolean;
    public log_to_file: boolean;
    public log_level: number;

    constructor() {
        this.environment = 'QA';
        this.browser = 'CHROME';
        this.num_parallel = 1;
        this.max_test_attempts = 1;
        this.max_event_attempts = 30;
        this.max_wait_time = 120;
        this.report_to_zephyr = false;
        this.run_local = true;
        this.log_to_file = false;
        this.log_level = 10;
    }
}

export class TestConfigViewProvider implements vscode.WebviewViewProvider {

    public static readonly viewType = 'calicoColors.colorsView';

    private _view?: vscode.WebviewView;

    constructor(
        private readonly _extensionUri: vscode.Uri
    ) { }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    public resolveWebviewView(webviewView: vscode.WebviewView, _context: vscode.WebviewViewResolveContext<unknown>, _token: vscode.CancellationToken): void | Thenable<void> {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                this._extensionUri
            ]
        }

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(data => {
            switch (data.type) {
                case 'colorSelected':
                    {
                        vscode.window.activeTextEditor?.insertSnippet(new vscode.SnippetString(`#${data.value}`));
                        break;
                    }
                case 'environment-changed':
                    {
                        console.log('Environment: ' + data.value)
                        break;
                    }
                case 'max-test-attempts-changed':
                    {
                        frameworkConfigValues.max_test_attempts = data.value;
                        break;
                    }
                case 'browser-changed':
                    {
                        frameworkConfigValues.browser = data.value;
                        break;
                    }
                case 'max-event-attempts-changed':
                    {
                        frameworkConfigValues.max_event_attempts = data.value;
                        break;
                    }
                case 'max-wait-time-changed':
                    {
                        frameworkConfigValues.max_wait_time = data.value;
                        break;
                    }
                case 'num-parallel-changed':
                    {
                        frameworkConfigValues.num_parallel = data.value;
                        break;
                    }
                case 'report-to-zephyr-changed':
                    {
                        frameworkConfigValues.report_to_zephyr = data.value;
                        break;
                    }
                case 'run-remote-changed':
                    {
                        frameworkConfigValues.run_local = !data.value;
                        console.log(frameworkConfigValues.run_local)
                        break;
                    }
            }
        });

    }

	public addColor() {
		if (this._view) {
			this._view.show?.(true); // `show` is not implemented in 1.49 but is for 1.50 insiders
			this._view.webview.postMessage({ type: 'addColor' });
		}
	}

	public clearColors() {
		if (this._view) {
			this._view.webview.postMessage({ type: 'clearColors' });
		}
	}

    private _getHtmlForWebview(webview: vscode.Webview) {
		// Get the local path to main script run in the webview, then convert it to a uri we can use in the webview.
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'main.js'));

		// Do the same for the stylesheet.
		const styleResetUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'reset.css'));
		const styleVSCodeUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'vscode.css'));
		const styleMainUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'main.css'));

		// Use a nonce to only allow a specific script to be run.
		const nonce = getNonce();

		return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">

				<!--
					Use a content security policy to only allow loading styles from our extension directory,
					and only allow scripts that have a specific nonce.
					(See the 'webview-sample' extension sample for img-src content security policy examples)
				-->
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">

				<meta name="viewport" content="width=device-width, initial-scale=1.0">

				<link href="${styleResetUri}" rel="stylesheet">
				<link href="${styleVSCodeUri}" rel="stylesheet">
				<link href="${styleMainUri}" rel="stylesheet">

				<title>Cat Colors</title>
			</head>
			<body>

                <p>Placeholder Text</p>

                <div class="settings">
                    <label for="environment">Environment</label>
                    <select class="add-color-button" id="environment">
                        <option value="DEV">Dev</option>
                        <option value="QA" selected>QA</option>
                        <option value="PROD">Production</option>
                    </select>

                    <label for="browser">Browser</label>
                    <select class="add-color-button" id="browser">
                        <option value="CHROME" selected>Chrome</option>
                        <option value="FIREFOX">Firefox</option>
                        <option value="EDGE">Edge</option>
                        <option value="SAFARI">Safari</option>
                    </select>

                    <label for="num-parallel">Parallel Tests</label>
                    <input class="add-color-button" id="num-parallel" type="number" min="1" max="1000" value="1" />

                    <label for="max-test-attempts">Max Test Attempts</label>
                    <input class="add-color-button" id="max-test-attempts" type="number" min="1" max="1000" value="1" />

                    <label for="max-event-attempts">Max Event Attempts</label>
                    <input class="add-color-button" id="max-event-attempts" type="number" min="1" max="1000" value="30" />

                    <label for="max-wait-time">Max Wait Time (sec)</label>
                    <input class="add-color-button" id="max-wait-time" type="number" min="1" max="1000" value="120" />

                    <label for="report-to-zephyr">Report To Zephyr</label>
                    <input class="add-color-button" id="report-to-zephyr" type="checkbox" />

                    <label for="run-remote">Run Remotely</label>
                    <input class="add-color-button" id="run-remote" type="checkbox" />
                </div>
                

				<script nonce="${nonce}" src="${scriptUri}"></script>
			</body>
			</html>`;
	}
    
}

function getNonce() {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}