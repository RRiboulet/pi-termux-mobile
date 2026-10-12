// Android signer: only public key metadata and DER signatures cross the UID-checked local socket.
import net from 'node:net';
export function keyStoreCall(request, socketName = process.env.PI_SPACES_KEY_SOCKET) {
  if (!socketName) return Promise.reject(new Error('Android Keystore service is unavailable'));
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: '\0' + socketName }); let result = '', settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => finish(new Error('Android Keystore timed out')), 5000);
    socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'));
    socket.on('error', error => finish(error)); socket.on('close', () => { if (!settled) finish(new Error('Android Keystore disconnected')); });
    socket.on('data', data => { result += data.toString('utf8'); if (Buffer.byteLength(result) > 16384) return finish(new Error('invalid Keystore reply')); const end = result.indexOf('\n'); if (end < 0) return; try { const reply = JSON.parse(result.slice(0, end)); if (!reply.ok) return finish(new Error(reply.error || 'Keystore refused request')); finish(null, reply.result); } catch (error) { finish(error); } });
  });
}
export async function androidSigner(alias) {
  const key = await keyStoreCall({ method: 'publicKey', alias });
  return { ...key, sign: async bytes => Buffer.from((await keyStoreCall({ method: 'sign', alias, bytes: Buffer.from(bytes).toString('base64') })).signature, 'base64') };
}
export async function createAndroidSigner(peerId, gateHostId) {
  const key = await keyStoreCall({ method: 'create', peerId, gateHostId });
  return androidSigner(key.alias);
}
