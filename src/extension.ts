import * as vscode from "vscode";
import { registerProctor } from "./participant.js";

export function activate(context: vscode.ExtensionContext) {
  registerProctor(context);
  console.log("Token Proctor activated");
}

export function deactivate() {}
