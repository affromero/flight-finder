import { accessRouteResponse } from '@/lib/sidedoor/access-http';

export async function POST(request: Request) {
  return accessRouteResponse(request, 'logout', {});
}
