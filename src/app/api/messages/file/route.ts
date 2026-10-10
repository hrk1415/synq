import { NextRequest } from 'next/server';
import { getAuthenticatedWallet, unauthorized } from '@/lib/auth';
import { createCanonicalFileMessage, getById } from '@/lib/db';
import { canonicalizeConversationPair, isConversationParticipant } from '@/lib/conversation-pair';
import {
  MAX_SYNQ_FILE_SIZE,
  SYNQ_FILE_MIME_EXTENSIONS,
  type SynqFileMimeType,
  type SynqFileMessagePayload,
} from '@/lib/synq-message';
import { removeSynqChatAttachment, uploadSynqChatAttachment } from '@/lib/storage';

export const runtime = 'nodejs';

const EVM_WALLET = /^0x[0-9a-fA-F]{40}$/;

function safeFileName(name: string, extension: string) {
  const leaf = name.split(/[\\/]/).pop() || `attachment.${extension}`;
  const withoutControls = leaf.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  const stem = withoutControls.replace(/\.[^.]*$/, '').replace(/[^a-zA-Z0-9 _().-]/g, '_').trim() || 'attachment';
  const maxStemLength = Math.max(1, 180 - extension.length - 1);
  return `${stem.slice(0, maxStemLength)}.${extension}`;
}

function bytesStartWith(bytes: Uint8Array, signature: number[]) {
  return signature.every((byte, index) => bytes[index] === byte);
}

function hasExpectedSignature(mimeType: SynqFileMimeType, bytes: Uint8Array) {
  switch (mimeType) {
    case 'image/jpeg': return bytesStartWith(bytes, [0xff, 0xd8, 0xff]);
    case 'image/png': return bytesStartWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'image/webp':
      return bytesStartWith(bytes, [0x52, 0x49, 0x46, 0x46])
        && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
    case 'application/pdf': return bytesStartWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]);
    case 'application/msword':
    case 'application/vnd.ms-excel':
      return bytesStartWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
      return bytesStartWith(bytes, [0x50, 0x4b, 0x03, 0x04])
        || bytesStartWith(bytes, [0x50, 0x4b, 0x05, 0x06])
        || bytesStartWith(bytes, [0x50, 0x4b, 0x07, 0x08]);
    default:
      return true;
  }
}

type UploadedFileMetadata = {
  name: string;
  size: number;
  type: string;
};

function validateFile(file: UploadedFileMetadata, bytes: Uint8Array) {
  if (!file.name || file.size <= 0) throw new Error('Choose a non-empty file');
  if (file.size > MAX_SYNQ_FILE_SIZE) throw new Error('File is too large (maximum 10 MB)');
  const mimeType = file.type as SynqFileMimeType;
  const extensions = SYNQ_FILE_MIME_EXTENSIONS[mimeType];
  if (!extensions) throw new Error('This file type is not supported');
  const suppliedExtension = file.name.split('.').pop()?.toLowerCase() || '';
  if (!(extensions as readonly string[]).includes(suppliedExtension)) {
    throw new Error('File extension does not match its type');
  }
  if (!hasExpectedSignature(mimeType, bytes)) throw new Error('File contents do not match its type');
  return {
    mimeType,
    extension: suppliedExtension,
    fileName: safeFileName(file.name, suppliedExtension),
  };
}

export async function POST(req: NextRequest) {
  const authenticatedWallet = getAuthenticatedWallet(req);
  if (!authenticatedWallet) return unauthorized();

  let storagePath = '';
  let stage = 'request-parse';
  try {
    const encodedFileName = req.headers.get('x-synq-file-name') || '';
    if (!encodedFileName || encodedFileName.length > 1_000) {
      return Response.json({ error: 'A valid filename is required' }, { status: 400 });
    }
    let originalFileName = '';
    try {
      originalFileName = decodeURIComponent(encodedFileName);
    } catch {
      return Response.json({ error: 'A valid filename is required' }, { status: 400 });
    }
    if (!originalFileName || originalFileName.length > 255) {
      return Response.json({ error: 'A valid filename is required' }, { status: 400 });
    }

    const conversationId = (req.headers.get('x-synq-conversation-id') || '').trim();
    const requestedRecipient = (req.headers.get('x-synq-to-wallet') || '').trim().toLowerCase();
    if (!!conversationId === !!requestedRecipient) {
      return Response.json({ error: 'Provide either conversationId or toWallet' }, { status: 400 });
    }

    const suppliedMimeType = (req.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
    const arrayBuffer = await req.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    const file: UploadedFileMetadata = {
      name: originalFileName,
      size: bytes.byteLength,
      type: suppliedMimeType,
    };

    stage = 'conversation-authorization';
    let toWallet = requestedRecipient;
    if (conversationId) {
      const conversation = await getById('conversations', conversationId);
      if (!conversation) return Response.json({ error: 'Conversation not found' }, { status: 404 });
      if (!isConversationParticipant(conversation, authenticatedWallet)) {
        return Response.json({ error: 'Not a participant in this conversation' }, { status: 403 });
      }
      toWallet = conversation.participantA === authenticatedWallet
        ? conversation.participantB
        : conversation.participantA;
    } else {
      if (!EVM_WALLET.test(toWallet)) {
        return Response.json({ error: 'Valid toWallet is required' }, { status: 400 });
      }
      canonicalizeConversationPair(authenticatedWallet, toWallet);
    }

    stage = 'file-validation';
    const validated = validateFile(file, bytes);
    storagePath = `attachments/${crypto.randomUUID()}.${validated.extension}`;
    const payload: SynqFileMessagePayload = {
      storagePath,
      fileName: validated.fileName,
      mimeType: validated.mimeType,
      size: file.size,
    };

    stage = 'storage-upload';
    await uploadSynqChatAttachment(storagePath, arrayBuffer, validated.mimeType);

    try {
      stage = 'message-persistence';
      const [sender, recipient] = await Promise.all([
        getById('users', authenticatedWallet),
        getById('users', toWallet),
      ]);
      const result = await createCanonicalFileMessage({
        fromWallet: authenticatedWallet,
        toWallet,
        fromName: sender?.name || undefined,
        toName: recipient?.name || undefined,
        payload,
      });
      return Response.json(result);
    } catch (error) {
      try {
        await removeSynqChatAttachment(storagePath);
      } catch (cleanupError: any) {
        console.error('[synqchat-attachment] cleanup failed', {
          stage: 'storage-cleanup',
          message: typeof cleanupError?.message === 'string' ? cleanupError.message : 'Unknown cleanup error',
        });
      }
      throw error;
    }
  } catch (error: any) {
    const diagnosticMessage = stage === 'storage-upload'
      ? 'Storage upload failed'
      : stage === 'message-persistence'
        ? 'Message persistence failed'
        : typeof error?.message === 'string' ? error.message : 'Unknown attachment error';
    console.error('[synqchat-attachment] request failed', {
      stage,
      message: diagnosticMessage,
    });
    const clientMessage = stage === 'storage-upload'
      ? 'Could not store attachment'
      : stage === 'message-persistence'
        ? 'Could not send attachment'
        : error?.message || 'Could not send attachment';
    return Response.json({ error: clientMessage }, { status: 400 });
  }
}
