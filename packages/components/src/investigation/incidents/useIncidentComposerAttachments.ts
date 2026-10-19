import { useCallback, useRef, useState, type ClipboardEvent } from "react";
import type { ModelCatalogEntry } from "../../llm/modelCatalog";
import type {
  ComposerAttachment,
  ComposerTextAttachmentMimeType,
} from "../../chat/types";
import { isSupportedTextAttachmentMimeType } from "./incidentNormalize";

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => {
      reject(reader.error ?? new Error("Failed to read image file."));
    };
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      resolve("");
    };
    reader.readAsDataURL(file);
  });
}

function getTextAttachmentMimeType(
  file: File,
): ComposerTextAttachmentMimeType | "text/csv" | undefined {
  if (file.type === "text/csv" || file.name.toLowerCase().endsWith(".csv")) {
    return "text/csv";
  }
  if (isSupportedTextAttachmentMimeType(file.type)) return file.type;

  const extension = file.name.toLowerCase().split(".").pop();
  if (extension === "md" || extension === "markdown") return "text/markdown";
  if (extension === "json") return "application/json";
  if (extension === "yaml" || extension === "yml") return "text/yaml";
  if (extension === "txt") return "text/plain";
  return undefined;
}

/** Composer attachments: file pickers, clipboard images and the attachment list. */
export function useIncidentComposerAttachments(
  selectedModelCapability: ModelCatalogEntry | undefined,
  composerSupportsFiles: boolean,
) {
  const [composerImages, setComposerImages] = useState<ComposerAttachment[]>([]);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handlePickImages = useCallback(() => {
    if (!selectedModelCapability?.supportsImageInput) return;
    imageInputRef.current?.click();
  }, [selectedModelCapability]);

  const handlePickFiles = useCallback(() => {
    if (!composerSupportsFiles) return;
    fileInputRef.current?.click();
  }, [composerSupportsFiles]);

  const handleAttachmentFilesSelected = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;

      const acceptedFiles = Array.from(files)
        .filter(
          (file) =>
            file.size <= 3 * 1024 * 1024 &&
            (file.type.startsWith("image/") ||
              getTextAttachmentMimeType(file) !== undefined),
        )
        .slice(0, Math.max(0, 4 - composerImages.length));

      const nextAttachments = await Promise.all(
        acceptedFiles
          .map(async (file): Promise<ComposerAttachment | null> => {
            const id = crypto.randomUUID();
            const name = file.name || "attachment";
            if (file.type.startsWith("image/")) {
              return {
                id,
                type: "image",
                name,
                mimeType: file.type || "image/png",
                sizeBytes: file.size,
                dataUrl: await readFileAsDataUrl(file),
              };
            }

            const mimeType = getTextAttachmentMimeType(file);
            if (mimeType === undefined) return null;
            const text = await file.text();
            if (mimeType === "text/csv") {
              const nonEmptyLines = text.split(/\r?\n/).filter((line) => line.length > 0);
              const rowCount = Math.max(0, nonEmptyLines.length - 1);
              return {
                id, type: "csv", name, mimeType, sizeBytes: file.size, text,
                rowCount, totalRowCount: rowCount,
              };
            }
            return { id, type: "text", name, mimeType, sizeBytes: file.size, text };
          }),
      );

      const attachments = nextAttachments.filter(
        (attachment): attachment is ComposerAttachment => attachment !== null,
      );
      if (attachments.length === 0) return;
      setComposerImages((prev) => [...prev, ...attachments].slice(0, 4));
    },
    [composerImages.length],
  );

  const handleComposerPaste = useCallback(
    async (event: ClipboardEvent<HTMLTextAreaElement>) => {
      if (!selectedModelCapability?.supportsImageInput) return;

      const clipboardItems = Array.from(event.clipboardData?.items ?? []);
      const imageFiles = clipboardItems
        .filter(
          (item) => item.kind === "file" && item.type.startsWith("image/"),
        )
        .map((item) => item.getAsFile())
        .filter((file): file is File => file instanceof File);

      if (imageFiles.length === 0) return;

      event.preventDefault();

      const transferable = new DataTransfer();
      for (const file of imageFiles) {
        transferable.items.add(file);
      }

      await handleAttachmentFilesSelected(transferable.files);
    },
    [handleAttachmentFilesSelected, selectedModelCapability],
  );

  const handleRemoveComposerImage = useCallback((imageId: string) => {
    setComposerImages((prev) => prev.filter((image) => image.id !== imageId));
  }, []);

  return {
    composerImages,
    setComposerImages,
    imageInputRef,
    fileInputRef,
    handlePickImages,
    handlePickFiles,
    handleAttachmentFilesSelected,
    handleComposerPaste,
    handleRemoveComposerImage,
  };
}
