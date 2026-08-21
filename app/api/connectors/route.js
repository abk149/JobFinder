import { listConnectors } from '../../../connectors/index.js';

export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json({ connectors: listConnectors() });
}
