import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import { badRequest, filePathQuerySchema, renameFileSchema, writeFileSchema } from '@serverforge/core';
import { requireServerAccess } from '../lib/auth.js';
import { recordActivity } from '../lib/events.js';
import { chownTreeForGame } from '../lib/ownership.js';
import { localDataPath } from '../lib/storage-paths.js';
import {
  createDirectory,
  deleteEntries,
  listDirectory,
  readFileContents,
  renameEntry,
  resolveDownload,
  resolveUploadTarget,
  writeFileContents,
} from '../services/files.js';

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

function serverRoot(server: { dataPath: string }): string {
  return localDataPath(server.dataPath);
}

export async function fileRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/servers/:uid/files', async (request) => {
    const { uid } = request.params as { uid: string };
    const { server } = await requireServerAccess(request, uid, 'server.files');
    const { path: relative } = filePathQuerySchema.parse(request.query);

    return { path: relative, entries: await listDirectory(serverRoot(server), relative) };
  });

  app.get('/api/servers/:uid/files/contents', async (request) => {
    const { uid } = request.params as { uid: string };
    const { server } = await requireServerAccess(request, uid, 'server.files');
    const { path: relative } = filePathQuerySchema.parse(request.query);

    return { path: relative, contents: await readFileContents(serverRoot(server), relative) };
  });

  app.put('/api/servers/:uid/files/contents', async (request) => {
    const { uid } = request.params as { uid: string };
    const { server, user } = await requireServerAccess(request, uid, 'server.files');
    const input = writeFileSchema.parse(request.body);

    await writeFileContents(serverRoot(server), input.path, input.content);
    await recordActivity({
      serverId: server.id,
      actorId: user.id,
      actorName: user.displayName,
      action: 'files.write',
      message: `${user.displayName} edited ${input.path}`,
    });

    return { ok: true };
  });

  app.post('/api/servers/:uid/files/folder', async (request) => {
    const { uid } = request.params as { uid: string };
    const { server } = await requireServerAccess(request, uid, 'server.files');
    const body = request.body as { path?: string; name?: string };

    if (!body.name) throw badRequest('Give the folder a name.');
    await createDirectory(serverRoot(server), body.path ?? '/', body.name);
    return { ok: true };
  });

  app.post('/api/servers/:uid/files/rename', async (request) => {
    const { uid } = request.params as { uid: string };
    const { server } = await requireServerAccess(request, uid, 'server.files');
    const input = renameFileSchema.parse(request.body);

    await renameEntry(serverRoot(server), input.from, input.to);
    return { ok: true };
  });

  app.post('/api/servers/:uid/files/delete', async (request) => {
    const { uid } = request.params as { uid: string };
    const { server, user } = await requireServerAccess(request, uid, 'server.files');
    const body = request.body as { paths?: string[] };

    if (!Array.isArray(body.paths) || body.paths.length === 0) {
      throw badRequest('Select at least one file to delete.');
    }
    if (body.paths.length > 500) throw badRequest('Delete at most 500 items at a time.');

    const deleted = await deleteEntries(serverRoot(server), body.paths);
    await recordActivity({
      serverId: server.id,
      actorId: user.id,
      actorName: user.displayName,
      action: 'files.delete',
      message: `${user.displayName} deleted ${deleted} item${deleted === 1 ? '' : 's'}.`,
    });

    return { ok: true, deleted };
  });

  app.get('/api/servers/:uid/files/download', async (request, reply) => {
    const { uid } = request.params as { uid: string };
    const { server } = await requireServerAccess(request, uid, 'server.files');
    const { path: relative } = filePathQuerySchema.parse(request.query);

    const file = await resolveDownload(serverRoot(server), relative);

    // `attachment` matters: a server config served inline would render in the
    // browser's origin, and an uploaded .html file would then be same-origin
    // script execution against the panel.
    reply
      .header('Content-Disposition', `attachment; filename="${encodeURIComponent(file.fileName)}"`)
      .header('Content-Type', 'application/octet-stream')
      .header('Content-Length', String(file.size))
      .header('X-Content-Type-Options', 'nosniff');

    return reply.send(createReadStream(file.absolutePath));
  });

  app.post('/api/servers/:uid/files/upload', async (request) => {
    const { uid } = request.params as { uid: string };
    const { server, user } = await requireServerAccess(request, uid, 'server.files');
    const query = request.query as { path?: string };

    const parts = request.parts({ limits: { fileSize: MAX_UPLOAD_BYTES, files: 20 } });
    const saved: string[] = [];

    for await (const part of parts) {
      if (part.type !== 'file') continue;

      const target = resolveUploadTarget(serverRoot(server), query.path ?? '/', part.filename);
      await fs.mkdir(path.dirname(target), { recursive: true });

      // Stream to a temp name and rename on success, so an aborted upload
      // never leaves a truncated jar that the server then tries to load.
      const temp = `${target}.sf-upload`;
      const { createWriteStream } = await import('node:fs');
      await pipeline(part.file, createWriteStream(temp));

      if (part.file.truncated) {
        await fs.rm(temp, { force: true });
        throw badRequest('That file is larger than the 2 GB upload limit.');
      }

      await fs.rename(temp, target);
      await fs.chown(target, 1000, 1000).catch(() => undefined);
      saved.push(part.filename);
    }

    if (saved.length === 0) throw badRequest('No files were uploaded.');

    await recordActivity({
      serverId: server.id,
      actorId: user.id,
      actorName: user.displayName,
      action: 'files.upload',
      message: `${user.displayName} uploaded ${saved.length} file${saved.length === 1 ? '' : 's'}.`,
      metadata: { files: saved },
    });

    return { ok: true, uploaded: saved };
  });

  /**
   * Unpacking is exposed as an explicit action rather than happening on
   * upload: modpack zips are the main use, and silently exploding an archive
   * over someone's config directory is not a surprise anyone enjoys.
   */
  app.post('/api/servers/:uid/files/unpack', async (request) => {
    const { uid } = request.params as { uid: string };
    const { server, user } = await requireServerAccess(request, uid, 'server.files');
    const body = request.body as { path?: string; destination?: string };

    if (!body.path) throw badRequest('Choose an archive to unpack.');
    if (!body.path.toLowerCase().endsWith('.zip')) {
      throw badRequest('Only .zip archives can be unpacked here.');
    }

    const { createInstallTools } = await import('../services/install-tools.js');
    const { getRuntime } = await import('../runtime/index.js');
    const tools = createInstallTools({
      dataPath: serverRoot(server),
      runtime: getRuntime(server.node),
    });

    const destination = body.destination ?? path.posix.dirname(body.path);
    await tools.unzip(body.path, destination);
    // Unpacked files are written as the API user; the game runs as uid 1000.
    await chownTreeForGame(path.join(serverRoot(server), destination));
    await recordActivity({
      serverId: server.id,
      actorId: user.id,
      actorName: user.displayName,
      action: 'files.unpack',
      message: `${user.displayName} unpacked ${body.path}`,
    });

    return { ok: true };
  });
}
