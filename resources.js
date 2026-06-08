import { tables } from 'harper';
import fs from 'node:fs';
import path from 'node:path';
import { generateHydrationScript } from 'solid-js/web';

if (!(await tables.Post.get('0'))) {
	await tables.Post.put({
		id: '0',
		title: 'Hello, World!',
		body: 'This is a test post. Please leave a comment! 📝',
		comments: [],
	});
}

const template = fs.readFileSync(path.join(import.meta.dirname, 'dist/client/index.html'), 'utf-8');
const serverEntry = await import('./dist/server/entry-server.js');

async function renderPost(post) {
	const rendered = serverEntry.render({ initialPostData: post });
	const head = (rendered.head ?? '') + generateHydrationScript();
	const html = template
		.replace(`<!--app-head-->`, head)
		.replace(`<!--app-html-->`, rendered.html ?? '')
		.replace(`<!--app-data-->`, `<script>window.__INITIAL_POST_DATA__ = ${JSON.stringify(post)};</script>`);

	return html;
}

export class UncachedBlog extends tables.Post {
	async get(query) {
		const post = await super.get(query);
		return {
			status: 200,
			headers: { 'Content-Type': 'text/html' },
			body: await renderPost(post),
		};
	}
}

// Caching source for BlogCache. In v5 a caching source resolves per-id through
// an instance `get`, so the cache instantiates this resource for the requested
// id and calls `get()`; `super.get()` returns the underlying Post record.
class PageBuilder extends tables.Post {
	async get(query) {
		const post = await super.get(query);
		return {
			content: await renderPost(post),
		};
	}
}

tables.BlogCache.sourcedFrom(PageBuilder);

export class CachedBlog extends tables.BlogCache {
	async get(query) {
		const cached = await super.get(query);
		return {
			contentType: 'text/html',
			data: cached.content,
		};
	}
}
