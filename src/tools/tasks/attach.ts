/**
 * Attach subcommand of `vikunja_tasks`.
 *
 * Uploads a file as an attachment on an existing task via the Vikunja REST
 * endpoint `PUT /tasks/{id}/attachments` (`multipart/form-data`, field name
 * `files`). The endpoint accepts multiple files per call; this handler
 * uploads a single file per invocation to keep the schema simple.
 *
 * Two ways to provide the file:
 *   - `filePath`: absolute path readable by the MCP server process.
 *   - `fileContent`: base64-encoded contents (typical when the MCP client
 *     runs on a different machine than the server).
 *
 * When both are present, `filePath` takes precedence. `filename` is optional
 * and falls back to `basename(filePath)` or `attachment.bin`. Any directory
 * components in `filename` are stripped before upload.
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { z } from 'zod';

import type { AuthManager } from '../../auth/AuthManager';
import { MCPError, ErrorCode } from '../../types';
import { vikunjaRestMultipartRequest } from '../../utils/vikunja-rest';

export const attachSchemaFields = {
  filePath: z.string().optional(),
  fileContent: z.string().optional(),
  filename: z.string().optional(),
};

export interface TaskAttachArgs {
  id?: number;
  filePath?: string;
  fileContent?: string;
  filename?: string;
}

interface AttachResult {
  content: Array<{ type: 'text'; text: string }>;
}

/**
 * Strict base64 shape check: groups of 4 alphabet characters, with an
 * optional final group padded by 1-2 `=`. Whitespace is not tolerated — a
 * base64-encoding caller has no reason to inject it, and permitting it would
 * widen what `Buffer.from` is trusted to decode.
 */
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export async function handleAttach(
  args: TaskAttachArgs,
  authManager: AuthManager,
): Promise<AttachResult> {
  const { id, filePath, fileContent, filename } = args ?? {};

  if (typeof id !== 'number' || !Number.isFinite(id) || id <= 0) {
    throw new MCPError(ErrorCode.VALIDATION_ERROR, 'attach requires a positive numeric task id');
  }

  let bytes: Buffer;
  let name: string;
  let source: 'filePath' | 'fileContent';

  if (filePath) {
    try {
      bytes = readFileSync(filePath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new MCPError(
        ErrorCode.VALIDATION_ERROR,
        `attach: cannot read filePath ${filePath}: ${message}`,
      );
    }
    name = filename || basename(filePath);
    source = 'filePath';
  } else if (fileContent) {
    // Node's `Buffer.from(str, 'base64')` is lenient: it silently skips
    // characters outside the base64 alphabet instead of rejecting them, so a
    // genuinely malformed string (bad characters, wrong padding) still
    // decodes to *some* bytes rather than throwing or landing on
    // `length === 0`. Validate the string's shape first — proper alphabet,
    // length a multiple of 4, at most two trailing `=` padding characters —
    // before trusting the decode, so corrupted input is rejected rather than
    // silently uploaded as corrupted bytes.
    if (!BASE64_PATTERN.test(fileContent)) {
      throw new MCPError(
        ErrorCode.VALIDATION_ERROR,
        'attach: fileContent is not valid base64 (invalid characters or padding)',
      );
    }
    // A non-empty string that passes BASE64_PATTERN always decodes to at
    // least one byte (the shortest valid non-empty group, e.g. 'AA==',
    // yields 1 byte), so there is no reachable empty-decode case left to
    // guard here once the shape is validated above.
    bytes = Buffer.from(fileContent, 'base64');
    name = filename || 'attachment.bin';
    source = 'fileContent';
  } else {
    throw new MCPError(ErrorCode.VALIDATION_ERROR, 'attach requires filePath or fileContent');
  }

  // Strip any directory component a caller might inject via `filename`.
  name = basename(name);

  const form = new FormData();
  form.append('files', new Blob([bytes]), name);

  // Uploads go through the shared REST helper's multipart variant, which
  // gives this call the same URL normalization, named circuit breaker, and
  // MCPError/statusCode error contract as every other direct-REST call —
  // it previously built its own URL by hand (skipping the `/api/v1`
  // normalization vikunjaRestRequest applies) and had no failure
  // protection at all. Retries stay off by default here (see
  // DEFAULT_MULTIPART_RETRY in vikunja-rest.ts): resending a file upload
  // after an ambiguous failure risks duplicating the attachment.
  const data = await vikunjaRestMultipartRequest(
    authManager,
    'PUT',
    `/tasks/${id}/attachments`,
    form,
  );

  const summary = { taskId: id, filename: name, bytes: bytes.length, source };

  return {
    content: [
      {
        type: 'text',
        text:
          `## ✅ Success\n\nAttached \`${name}\` (${bytes.length} bytes) to task #${id}\n\n` +
          `**Operation:** attach-task-file\n\n` +
          '```json\n' +
          JSON.stringify({ summary, response: data }, null, 2) +
          '\n```',
      },
    ],
  };
}
