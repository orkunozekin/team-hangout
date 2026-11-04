import { File } from 'expo-file-system';
import { fetch } from 'expo/fetch';
import * as DocumentPicker from 'expo-document-picker';
import { ATTACHMENT_MAX_BYTES } from '../../shared/attachments';

export class AttachmentTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttachmentTransportError';
  }
}

export type AttachmentGrant = { uploadUrl: string; token: string; expiresAt: string; maxBytes: number };

/** Local file bytes stay in the cache copy. The picker MIME type is not sent as proof of content. */
export async function pickConversationAttachment(): Promise<{ file: File; name: string; size: number } | null> {
  const picked = await DocumentPicker.getDocumentAsync({
    type: ['image/jpeg', 'image/png', 'application/pdf'],
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (picked.canceled || picked.assets?.length !== 1) return null;
  const asset = picked.assets[0];
  if (!asset?.uri || !asset.name || asset.name.length > 120) throw new AttachmentTransportError('Use a JPEG, PNG, or PDF file name.');
  const file = new File(asset.uri);
  if (file.size > ATTACHMENT_MAX_BYTES) throw new AttachmentTransportError('This file is larger than 10 MB.');
  if (file.size < 1) throw new AttachmentTransportError('This file is empty.');
  return { file, name: asset.name, size: file.size };
}

export async function uploadConversationFile(file: File, grant: AttachmentGrant) {
  if (!Number.isFinite(Date.parse(grant.expiresAt)) || Date.parse(grant.expiresAt) <= Date.now()) {
    throw new AttachmentTransportError('This upload expired. Choose the file again.');
  }
  if (file.size > ATTACHMENT_MAX_BYTES) throw new AttachmentTransportError('This file is larger than 10 MB.');
  if (file.size < 1 || file.size !== grant.maxBytes) throw new AttachmentTransportError('This file does not match the reserved upload.');
  const response = await fetch(grant.uploadUrl, {
    method: 'PUT',
    headers: { Authorization: `Attachment ${grant.token}`, 'Content-Type': 'application/octet-stream' },
    body: file as never,
  });
  if (response.ok) return;
  if (response.status === 410) throw new AttachmentTransportError('This upload expired. Choose the file again.');
  if (response.status === 413) throw new AttachmentTransportError('This file is larger than 10 MB.');
  throw new AttachmentTransportError('This file was not uploaded.');
}

export async function downloadConversationFile(file: File, input: { downloadUrl: string; idToken: string; orgId: string; scopeType: string; scopeId: string; attachmentId: string }) {
  const response = await fetch(input.downloadUrl, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${input.idToken}`,
      'X-Org-Id': input.orgId,
      'X-Scope-Type': input.scopeType,
      'X-Scope-Id': input.scopeId,
      'X-Attachment-Id': input.attachmentId,
    },
  });
  if (!response.ok) throw new AttachmentTransportError('This file is unavailable.');
  file.write(await response.bytes());
}
