import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalJson, capturePurchaseSnapshot, replayPurchaseSnapshot } from '../lib/server/purchase-snapshots.js';
import type { PurchaseInput } from '../lib/server/purchase-engine.js';

export async function runPurchaseReplay(args: string[]) {
  const [command, path, output] = args;
  if (command === 'capture' && path && output && args.length === 3) {
    const request = JSON.parse(await readFile(path, 'utf8')) as { list_id: string; inputs: PurchaseInput };
    if (Object.keys(request).some(key => !['list_id', 'inputs'].includes(key))) throw new Error('invalid_capture_fields');
    const snapshot = capturePurchaseSnapshot(request.list_id, request.inputs);
    // Never overwrite a historical file, including when input/output paths coincide.
    await writeFile(output, canonicalJson(snapshot) + '\n', { flag: 'wx' });
    return 'Snapshot local guardado; sin activación.';
  }
  if (command === 'replay' && path && args.length === 2) {
    replayPurchaseSnapshot(JSON.parse(await readFile(path, 'utf8')));
    return 'Replay idéntico verificado.';
  }
  throw new Error('Uso: purchase-replay capture <entrada.json> <snapshot.json> | replay <snapshot.json>');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runPurchaseReplay(process.argv.slice(2)).then(message => console.log(message)).catch(() => {
    console.error('No se pudo guardar o reproducir el snapshot local. Comprueba el formato, las versiones, la integridad y la ruta de salida (debe ser nueva).');
    process.exitCode = 1;
  });
}
