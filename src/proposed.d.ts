// Minimal declarations from microsoft/vscode's MIT-licensed API proposals.
// Keep in sync with the three enabledApiProposals in package.json.
declare module 'vscode' {
  export enum LanguageModelChatMessageRole { System = 0 }
  export class LanguageModelThinkingPart {
    value: string | string[];
    id?: string;
    metadata?: { readonly [key: string]: unknown };
    constructor(value: string | string[], id?: string, metadata?: { readonly [key: string]: unknown });
  }
  export interface LanguageModelChatInformation {
    readonly isBYOK?: boolean;
    readonly configurationSchema?: { readonly properties?: { readonly [key: string]: Record<string, unknown> } };
  }
  export interface ProvideLanguageModelChatResponseOptions {
    readonly modelConfiguration?: { readonly [key: string]: unknown };
  }
}
