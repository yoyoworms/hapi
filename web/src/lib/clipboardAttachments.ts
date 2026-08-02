/**
 * Clipboard images are not represented consistently across browsers/targets:
 * textarea paste usually fills `files`, while contenteditable/Safari can expose
 * the same image only through `items[].getAsFile()`.
 */
export function getClipboardImageFiles(
    clipboardData: Pick<DataTransfer, 'files' | 'items'> | null | undefined
): File[] {
    if (!clipboardData) return []

    const files = Array.from(clipboardData.files ?? [])
        .filter((file) => file.type.startsWith('image/'))
    if (files.length > 0) return files

    return Array.from(clipboardData.items ?? [])
        .filter((item) => item.kind === 'file')
        .map((item) => item.getAsFile())
        .filter((file): file is File => Boolean(file?.type.startsWith('image/')))
}
