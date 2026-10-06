import { apiSuccess } from '@/lib/api-response';
import { readParseJob } from '@/lib/parsing/jobs';
import { privateParseEndpoint, requestParseActor } from '@/lib/parsing/http';

type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context): Promise<Response> {
  return privateParseEndpoint(async () => apiSuccess(await readParseJob((await context.params).id, await requestParseActor(request))));
}

export async function DELETE(request: Request, context: Context): Promise<Response> {
  return privateParseEndpoint(async () => apiSuccess(await readParseJob((await context.params).id, await requestParseActor(request), true)));
}
