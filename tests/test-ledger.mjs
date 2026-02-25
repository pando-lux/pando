import { PandoLedger } from '@pando/ledger';
import { WorkType, ApiProvider } from '@pando/shared';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Use temp dir so we don't pollute ~/.pando
const testDir = mkdtempSync(join(tmpdir(), 'pando-test-'));
const ledger = new PandoLedger(testDir);

console.log('=== Pando Ledger Test ===');
console.log('');

// 1. Register nodes
console.log('1. Registering nodes...');
const alice = ledger.registerNode('alice-peer-id', 'alice-pubkey');
const bob = ledger.registerNode('bob-peer-id', 'bob-pubkey');
console.log(`   Alice: ${alice.peerId}, balance: ${alice.balance} Lux`);
console.log(`   Bob: ${bob.peerId}, balance: ${bob.balance} Lux`);

// 2. Reward work (emission)
console.log('');
console.log('2. Rewarding Alice for answering a query...');
const reward1 = ledger.rewardWork('alice-peer-id', WorkType.QUERY_ANSWERED, 'answered: what is Pando?');
console.log(`   Alice earned ${reward1} Lux (5x early multiplier)`);

console.log('   Rewarding Bob for verifying code...');
const reward2 = ledger.rewardWork('bob-peer-id', WorkType.CODE_VERIFIED, 'verified: hello-world service');
console.log(`   Bob earned ${reward2} Lux (5x early multiplier)`);

// Check balances
const aliceBalance = ledger.accounts.getBalance('alice-peer-id');
const bobBalance = ledger.accounts.getBalance('bob-peer-id');
console.log(`   Alice balance: ${aliceBalance} Lux`);
console.log(`   Bob balance: ${bobBalance} Lux`);

// 3. Transfer
console.log('');
console.log('3. Alice sends 2 Lux to Bob...');
const tx = ledger.transfer('alice-peer-id', 'bob-peer-id', 2);
console.log(`   Transaction: ${tx.id.slice(0, 16)}...`);
console.log(`   Amount: ${tx.amount} Lux, Fee (burned): ${tx.fee} Lux`);
console.log(`   Alice balance: ${ledger.accounts.getBalance('alice-peer-id')} Lux`);
console.log(`   Bob balance: ${ledger.accounts.getBalance('bob-peer-id')} Lux`);

// 4. API key contribution
console.log('');
console.log('4. Alice registers an API key contribution...');
const contribution = ledger.registerApiKey('alice-peer-id', ApiProvider.CLAUDE, 50);
console.log(`   Contribution #${contribution.id}: Claude, $${contribution.monthlyCap}/month cap`);

console.log('   Recording API usage ($0.05 for a query)...');
const apiReward = ledger.recordApiUsage(contribution.id, 0.05, 'processed query: weather in NYC');
console.log(`   Alice earned ${apiReward} Lux for API contribution`);

// 5. Network stats
console.log('');
console.log('5. Network stats:');
const stats = ledger.getNetworkStats();
console.log(`   Total supply: ${stats.totalSupply} Lux (cap: ${stats.hardCap.toLocaleString()})`);
console.log(`   Total burned: ${stats.totalBurned} Lux`);
console.log(`   Circulating: ${stats.circulatingSupply} Lux`);
console.log(`   Accounts: ${stats.totalAccounts}`);
console.log(`   Transactions: ${stats.totalTransactions}`);
console.log(`   Active contributors: ${stats.activeContributors}`);
console.log(`   API spend: $${stats.totalApiSpend}`);

// 6. Peer summary
console.log('');
console.log('6. Alice\'s full summary:');
const summary = ledger.getPeerSummary('alice-peer-id');
console.log(`   Balance: ${summary.account.balance} Lux`);
console.log(`   Transactions: ${summary.recentTransactions.length}`);
console.log(`   API contributions: ${summary.apiContributions.length}`);

console.log('');
console.log('=== ALL TESTS PASSED ===');

ledger.close();
