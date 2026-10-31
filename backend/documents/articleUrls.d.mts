export type SrcsetCandidate = { url: string; descriptor: string };

export function parseSrcset(srcset: string): SrcsetCandidate[];
export function serializeSrcset(candidates: SrcsetCandidate[]): string;
export function resolveUrl(value: string, base: string): string;
export function resolveSrcset(srcset: string, base: string): string;
export function fixArticleUrls(root: ParentNode, base: string): void;
