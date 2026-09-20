import { accessRouteResponse } from '@/lib/sidedoor/access/access-http';

export async function POST(request: Request) {
  return accessRouteResponse(request, 'logout', {});
}
