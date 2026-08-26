/**
 * Integration tests for the Solid SSR + Harper multi-tier caching example.
 *
 * Verifies, against a real Harper v5 instance:
 *  - The component boots and seeds the initial Post record (resources.js startup code).
 *  - The Post table is exposed over REST (GET/PATCH) and returns a plain v5 record.
 *  - The UncachedBlog resource server-side-renders the Solid app to HTML on every request.
 *  - The CachedBlog resource (BlogCache sourcedFrom PageBuilder) renders, then serves
 *    conditional-request cache hits (304) and correctly invalidates when the Post changes.
 *
 * The example app must be built (Vite SSR -> dist/) before Harper can serve it, because
 * resources.js reads dist/client/index.html and imports dist/server/entry-server.js. The
 * `pretest:integration` npm script runs the build; this suite assembles a clean component
 * fixture (config.yaml, resources.js, schema.graphql, dist/) in a temp dir and pre-installs
 * it via setupHarperWithFixture so the routes are live on first boot.
 *
 * resources.js also imports `solid-js/web` at runtime (for generateHydrationScript), so the
 * fixture includes a minimal node_modules with solid-js and its runtime deps — mirroring a
 * real component deployment where the package's dependencies are installed alongside it.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { cp, mkdtemp, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const require = createRequire(import.meta.url);
// harper's `exports` only exposes ".", so 'harper/dist/bin/harper.js' is not resolvable.
// Resolve the CLI from the exported main entry and pass it explicitly as harperBinPath.
const harperBinPath = resolve(dirname(require.resolve('harper')), 'bin/harper.js');

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Assemble a clean Harper component directory in a temp location containing only the
 * files the component needs at runtime, including the built dist/ output.
 */
async function buildFixture(): Promise<string> {
	const distDir = join(projectRoot, 'dist');
	assert.ok(
		existsSync(join(distDir, 'client', 'index.html')) && existsSync(join(distDir, 'server', 'entry-server.js')),
		'dist/ is missing — run `npm run build` (the pretest:integration script does this) before the integration tests.'
	);

	const fixtureParent = await mkdtemp(join(tmpdir(), 'solid-ssr-fixture-'));
	const fixtureDir = join(fixtureParent, 'solid-ssr-example');
	await mkdir(fixtureDir, { recursive: true });

	for (const file of ['config.yaml', 'resources.js', 'schema.graphql']) {
		await cp(join(projectRoot, file), join(fixtureDir, file));
	}
	await cp(distDir, join(fixtureDir, 'dist'), { recursive: true });

	// resources.js imports 'solid-js/web' at runtime, so the component needs solid-js and
	// its (closed) runtime dependency set available in its own node_modules.
	const nodeModules = join(projectRoot, 'node_modules');
	const runtimeDeps = ['solid-js', 'csstype', 'seroval', 'seroval-plugins'];
	for (const dep of runtimeDeps) {
		await cp(join(nodeModules, dep), join(fixtureDir, 'node_modules', dep), { recursive: true });
	}

	return fixtureDir;
}

/**
 * Issue a conditional GET (If-None-Match / If-Modified-Since) and return the status.
 * The cache entry is written by `sourcedFrom` resolution, which can settle slightly after
 * the first response is sent, so we retry briefly to obtain a stable cache hit.
 */
async function conditionalGet(url: string, etag: string | null, lastModified: string | null): Promise<Response> {
	const headers: Record<string, string> = {};
	if (etag) headers['If-None-Match'] = etag;
	if (lastModified) headers['If-Modified-Since'] = lastModified;
	let res = await fetch(url, { headers });
	for (let attempt = 0; attempt < 10 && res.status !== 304; attempt++) {
		await res.text();
		await sleep(250);
		res = await fetch(url, { headers });
	}
	return res;
}

/**
 * Re-prime cache validators on each attempt, then issue a conditional GET, until a stable
 * 304 cache hit is observed. Used after a source mutation, where the cache entry may continue
 * to re-source briefly (changing its validators) before settling.
 */
async function awaitStableCacheHit(url: string, accept: string): Promise<Response> {
	let last: Response | null = null;
	for (let attempt = 0; attempt < 12; attempt++) {
		const fresh = await fetch(url, { headers: { Accept: accept } });
		await fresh.text();
		const conditional = await fetch(url, {
			headers: {
				Accept: accept,
				...(fresh.headers.get('ETag') ? { 'If-None-Match': fresh.headers.get('ETag') as string } : {}),
				...(fresh.headers.get('Last-Modified')
					? { 'If-Modified-Since': fresh.headers.get('Last-Modified') as string }
					: {}),
			},
		});
		if (conditional.status === 304) return conditional;
		await conditional.text();
		last = conditional;
		await sleep(250);
	}
	if (last === null) throw new Error('awaitStableCacheHit: all fetch attempts threw for ' + url);
	return last;
}

void suite('Solid SSR + Harper caching', (ctx: ContextWithHarper) => {
	before(async () => {
		const fixtureDir = await buildFixture();
		await setupHarperWithFixture(ctx, fixtureDir, { harperBinPath });
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	void test('seeds the initial Post and exposes it over REST', async () => {
		const res = await fetch(`${ctx.harper.httpURL}/Post/0`, {
			headers: { Accept: 'application/json' },
		});
		assert.equal(res.status, 200);
		const post = (await res.json()) as {
			id: string;
			title: string;
			body: string;
			comments: string[];
		};
		assert.equal(post.id, '0');
		assert.equal(post.title, 'Hello, World!');
		assert.ok(Array.isArray(post.comments));
	});

	void test('UncachedBlog server-side-renders the Solid app to HTML', async () => {
		const res = await fetch(`${ctx.harper.httpURL}/UncachedBlog/0`);
		assert.equal(res.status, 200);
		assert.match(res.headers.get('content-type') ?? '', /text\/html/);
		const html = await res.text();
		// SSR'd Solid markup should contain the seeded post title and the hydration root.
		assert.match(html, /Hello, World!/);
		assert.match(html, /This is a test post/);
		assert.match(html, /window\.__INITIAL_POST_DATA__/);
	});

	void test('CachedBlog renders SSR HTML into the cache and serves identical bytes from cache', async () => {
		const blogURL = `${ctx.harper.httpURL}/CachedBlog/0`;

		const first = await fetch(blogURL);
		assert.equal(first.status, 200);
		assert.match(first.headers.get('content-type') ?? '', /text\/html/);
		const firstHTML = await first.text();

		// Regression guard for the v5 caching-source bug: if the cache source uses a *static*
		// get(), Harper never invokes it (it instantiates the source and calls instance get()),
		// the cache stores the raw Post record, and CachedBlog's `cached.content` is undefined —
		// yielding a 200 with an EMPTY body. Assert the body is non-empty and actually contains
		// the SSR'd markers so a fallthrough-to-raw-record regression fails loudly here.
		assert.ok(firstHTML.length > 0, 'CachedBlog must serve a non-empty rendered HTML body');
		assert.match(firstHTML, /window\.__INITIAL_POST_DATA__/, 'cached HTML must contain the SSR hydration data');
		assert.match(firstHTML, /Hello, World!/, 'cached HTML must contain the rendered post title');
		assert.match(firstHTML, /This is a test post/, 'cached HTML must contain the rendered post body');

		// A second request for the same (unchanged) Post must serve byte-identical cached HTML.
		const second = await fetch(blogURL);
		assert.equal(second.status, 200);
		const secondHTML = await second.text();
		assert.equal(secondHTML, firstHTML, 'cached render should be byte-identical for an unchanged Post');
	});

	// The CachedBlog endpoint reads through the BlogCache (sourcedFrom PageBuilder). Exercising
	// the conditional-request (ETag/304) path THROUGH /CachedBlog — not just the raw BlogCache
	// table — confirms the rendered HTML cache entry participates in Harper's caching protocol.
	void test('CachedBlog serves a conditional cache hit (304) for rendered HTML', async () => {
		const blogURL = `${ctx.harper.httpURL}/CachedBlog/0`;

		const first = await fetch(blogURL);
		assert.equal(first.status, 200);
		const firstHTML = await first.text();
		assert.match(firstHTML, /window\.__INITIAL_POST_DATA__/);
		const etag = first.headers.get('ETag');
		const lastModified = first.headers.get('Last-Modified');
		assert.ok(etag || lastModified, 'CachedBlog response should carry cache validators (ETag/Last-Modified)');

		const conditional = await conditionalGet(blogURL, etag, lastModified);
		assert.equal(conditional.status, 304, `expected 304 cache hit on /CachedBlog, got ${conditional.status}`);
	});

	// The BlogCache table is the Harper caching primitive (sourcedFrom PageBuilder, expiration: 3600)
	// and is exported directly. It exercises Harper's native conditional-request (ETag/304) handling.
	void test('BlogCache table serves a conditional cache hit (304)', async () => {
		const cacheURL = `${ctx.harper.httpURL}/BlogCache/0`;

		const first = await fetch(cacheURL, { headers: { Accept: 'application/json' } });
		assert.equal(first.status, 200);
		await first.text();
		const etag = first.headers.get('ETag');
		const lastModified = first.headers.get('Last-Modified');
		assert.ok(etag || lastModified, 'BlogCache response should carry cache validators (ETag/Last-Modified)');

		const conditional = await conditionalGet(cacheURL, etag, lastModified);
		assert.equal(conditional.status, 304, `expected 304 cache hit, got ${conditional.status}`);
	});

	void test('updating the source Post invalidates the cached CachedBlog render, then re-caches', async () => {
		// Drive invalidation THROUGH the /CachedBlog endpoint (rendered HTML), not just the raw
		// BlogCache table, so the test covers the read-through render path the example serves.
		const blogURL = `${ctx.harper.httpURL}/CachedBlog/0`;
		const postURL = `${ctx.harper.httpURL}/Post/0`;

		// Prime the cache and confirm a stable cache hit on the rendered HTML.
		const primed = await fetch(blogURL);
		assert.equal(primed.status, 200);
		const primedHTML = await primed.text();
		assert.match(primedHTML, /window\.__INITIAL_POST_DATA__/, 'primed CachedBlog body must be rendered HTML');
		const etag = primed.headers.get('ETag');
		const lastModified = primed.headers.get('Last-Modified');

		const beforeMutation = await conditionalGet(blogURL, etag, lastModified);
		assert.equal(beforeMutation.status, 304);

		// Mutate the source Post via REST PATCH with a uniquely-identifiable comment so we can
		// confirm the re-rendered HTML reflects the new source data.
		const marker = `Integration comment ${Date.now()}`;
		const current = (await (await fetch(postURL, { headers: { Accept: 'application/json' } })).json()) as {
			comments: string[];
		};
		const patch = await fetch(postURL, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				comments: [...current.comments, marker],
			}),
		});
		assert.ok(patch.ok, `PATCH should succeed, got ${patch.status}`);

		// The previously-valid cache validators must now be stale -> 200 with a fresh entry.
		const afterMutation = await fetch(blogURL, {
			headers: {
				...(etag ? { 'If-None-Match': etag } : {}),
				...(lastModified ? { 'If-Modified-Since': lastModified } : {}),
			},
		});
		assert.equal(
			afterMutation.status,
			200,
			`expected cache invalidation (200) after Post update, got ${afterMutation.status}`
		);
		const afterHTML = await afterMutation.text();
		// The re-sourced render must include the new comment from the mutated Post.
		assert.ok(
			afterHTML.includes(marker),
			're-cached CachedBlog HTML must reflect the updated source Post'
		);

		// Once the freshly re-sourced entry settles, conditional requests should again 304.
		const reCached = await awaitStableCacheHit(blogURL, 'text/html');
		assert.equal(reCached.status, 304, `expected re-cached 304 after refresh, got ${reCached.status}`);
	});
});
