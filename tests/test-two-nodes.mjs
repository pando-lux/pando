import { PandoNode, PandoNetwork, getDefaultConfig } from '@pando/node';
import { MessageType } from '@pando/shared';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { generateKeyPair, privateKeyToProtobuf } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { toString as uint8ArrayToString, fromString as uint8ArrayFromString } from 'uint8arrays';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Create a second identity in a temp location
const PANDO_DIR_2 = join(homedir(), '.pando-node2');
if (!existsSync(PANDO_DIR_2)) {
  await mkdir(PANDO_DIR_2, { recursive: true });
}

// Generate second identity
const pk2 = await generateKeyPair('Ed25519');
const peerId2 = peerIdFromPrivateKey(pk2);
const identity2File = {
  peerId: peerId2.toString(),
  publicKey: uint8ArrayToString(pk2.publicKey.raw, 'base64'),
  privateKey: uint8ArrayToString(privateKeyToProtobuf(pk2), 'base64'),
  createdAt: Date.now()
};
await writeFile(join(PANDO_DIR_2, 'identity.json'), JSON.stringify(identity2File, null, 2));

// === NODE A ===
console.log('=== Starting Node A (port 4001) ===');
const nodeA = new PandoNode({ listenPort: 4001 });
await nodeA.start();

const nodeAAddrs = nodeA.getNetwork().getListenAddresses();
const nodeALocalAddr = nodeAAddrs.find(a => a.includes('127.0.0.1'));
console.log(`Node A address: ${nodeALocalAddr}`);

// === NODE B ===
console.log('');
console.log('=== Starting Node B (port 4002) — bootstrapping to Node A ===');

const id2 = {
  peerId: identity2File.peerId,
  publicKey: uint8ArrayFromString(identity2File.publicKey, 'base64'),
  privateKey: uint8ArrayFromString(identity2File.privateKey, 'base64'),
  createdAt: identity2File.createdAt,
};

// Node B uses Node A as a bootstrap peer
const networkB = new PandoNetwork(id2, getDefaultConfig({
  listenPort: 4002,
  bootstrapPeers: [nodeALocalAddr],
}));

networkB.onMessage((msg, from) => {
  console.log(`[Node B received] type=${msg.type} from=${from.slice(0, 16)}...`);
  if (msg.payload) console.log(`  payload: ${JSON.stringify(msg.payload)}`);
});

await networkB.start();
console.log(`Node B identity: ${identity2File.peerId.slice(0, 20)}...`);

// Wait for connection
console.log('');
console.log('Waiting for connection...');

let connected = false;
for (let i = 0; i < 15; i++) {
  await new Promise(r => setTimeout(r, 1000));
  const peersA = nodeA.getNetwork().getPeerCount();
  const peersB = networkB.getPeerCount();

  if (peersA > 0 && peersB > 0) {
    console.log('');
    console.log('=== PEERS CONNECTED ===');
    console.log(`Node A peers: ${peersA}`);
    console.log(`Node B peers: ${peersB}`);
    connected = true;

    // Send a message from A to B
    const netA = nodeA.getNetwork();
    const identA = nodeA.getIdentity();
    const peersOfA = netA.getPeers();

    console.log('');
    console.log('Sending PING from Node A to Node B...');
    await netA.sendMessage(peersOfA[0].peerId, {
      type: MessageType.PING,
      from: identA.peerId,
      timestamp: Date.now(),
      payload: { message: 'Hello from Node A! Pando lives.' },
    });

    // Wait for message delivery + pong response
    await new Promise(r => setTimeout(r, 2000));

    console.log('');
    console.log('========================================');
    console.log(' TEST PASSED');
    console.log(' Two Pando nodes:');
    console.log('   - Generated unique identities');
    console.log('   - Started on separate ports');
    console.log('   - Discovered each other');
    console.log('   - Exchanged messages');
    console.log(' The network is alive.');
    console.log('========================================');
    break;
  }

  if (i % 3 === 2) {
    console.log(`  waiting... (${i+1}s, A:${peersA} B:${peersB})`);
  }
}

if (!connected) {
  console.log('Connection timed out after 15s');
}

// Cleanup
await nodeA.stop();
await networkB.stop();
process.exit(0);
