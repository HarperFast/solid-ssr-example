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
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
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

	return fixtureDir;
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

	void test('CachedBlog renders HTML and serves a conditional cache hit (304)', async () => {
		const blogURL = `${ctx.harper.httpURL}/CachedBlog/0`;

		const first = await fetch(blogURL);
		assert.equal(first.status, 200);
		assert.match(first.headers.get('content-type') ?? '', /text\/html/);
		const firstHTML = await first.text();
		assert.match(firstHTML, /Hello, World!/);

		const etag = first.headers.get('ETag');
		const lastModified = first.headers.get('Last-Modified');
		assert.ok(etag || lastModified, 'CachedBlog response should carry cache validators (ETag/Last-Modified)');

		const conditional = await fetch(blogURL, {
			headers: {
				...(etag ? { 'If-None-Match': etag } : {}),
				...(lastModified ? { 'If-Modified-Since': lastModified } : {}),
			},
		});
		assert.equal(conditional.status, 304, `expected 304 cache hit, got ${conditional.status}`);
	});

	void test('updating the Post invalidates the cache, then re-caches', async () => {
		const blogURL = `${ctx.harper.httpURL}/CachedBlog/0`;
		const postURL = `${ctx.harper.httpURL}/Post/0`;

		// Prime the cache and capture validators.
		const primed = await fetch(blogURL);
		assert.equal(primed.status, 200);
		await primed.text();
		const etag = primed.headers.get('ETag');
		const lastModified = primed.headers.get('Last-Modified');

		// Confirm it's a cache hit before mutation.
		const beforeMutation = await fetch(blogURL, {
			headers: {
				...(etag ? { 'If-None-Match': etag } : {}),
				...(lastModified ? { 'If-Modified-Since': lastModified } : {}),
			},
		});
		assert.equal(beforeMutation.status, 304);

		// Mutate the source Post via REST PATCH.
		const current = (await (await fetch(postURL, { headers: { Accept: 'application/json' } })).json()) as {
			comments: string[];
		};
		const patch = await fetch(postURL, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				comments: [...current.comments, `Integration comment ${Date.now()}`],
			}),
		});
		assert.ok(patch.ok, `PATCH should succeed, got ${patch.status}`);

		// The previously-valid cache entry must now be stale -> 200 with fresh content.
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
		await afterMutation.text();

		// New validators should again produce a cache hit.
		const newEtag = afterMutation.headers.get('ETag');
		const newLastModified = afterMutation.headers.get('Last-Modified');
		const reCached = await fetch(blogURL, {
			headers: {
				...(newEtag ? { 'If-None-Match': newEtag } : {}),
				...(newLastModified ? { 'If-Modified-Since': newLastModified } : {}),
			},
		});
		assert.equal(reCached.status, 304, `expected re-cached 304 after refresh, got ${reCached.status}`);
	});
});
