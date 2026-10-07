export declare const EXCLUDE: readonly RegExp[]
export declare function excluded(srcPath: string): boolean
export declare function copyDocs(source: string, target: string): { files: number; redacted: number }
