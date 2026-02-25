import { EC2Client, GetConsoleOutputCommand } from '@aws-sdk/client-ec2';

const instanceId = process.argv[2] || 'i-0ee79c43c6c220359';
const ec2 = new EC2Client({ region: 'us-east-1' });

try {
  const result = await ec2.send(new GetConsoleOutputCommand({ InstanceId: instanceId }));
  if (result.Output) {
    const decoded = Buffer.from(result.Output, 'base64').toString('utf8');
    const lines = decoded.split('\n');
    console.log(`--- Console Output (last 100 lines of ${lines.length} total) ---`);
    console.log(lines.slice(-100).join('\n'));
  } else {
    console.log('No console output yet (instance still booting)');
  }
} catch (e) {
  console.error('Error:', e.message);
}
