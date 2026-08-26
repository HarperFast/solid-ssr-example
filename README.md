# Harper Solid SSR Example

This repo is an example of how to implement Solid SSR using Harper Resources to efficiently generate a _Blog_ from a database of _Posts_.

It includes complete client side hydration as well, resulting in a fully interactive web app experience.

> [!TIP]
> Watch a walkthrough of this example here: [Server-side Rendering (SSR) with Multi-Tier Cache Demo](https://youtu.be/L-tnBNhO9Fc)

## Get Started

1. `npm i`
2. `npm run build`
3. `harper run .`
4. Navigate to [/UncachedBlog/0](http://localhost:9926/UncachedBlog/0) or [/CachedBlog/0](http://localhost:9926/CachedBlog/0)
5. Add or remove comments!

The application is fully interactive and leverages a WebHook on the _Post_ to keep the page synced with the database record.

Regardless of caching, the pages are server side rendered. In the caching example, it will only rerender when the _Post_ has been updated.

Otherwise, clients should always receive a 304 status code!

## Help

- The `resources.js` file will generate a Post record automatically on startup, but won't overwrite an existing one.

- If you want to clear the Post record, use the command: `curl -X DELETE http://localhost:9926/Post/0`

- If you want to clear the comments on the Post, use the command:

```sh
curl -X PATCH http://localhost:9926/Post/0 \
-H "Content-Type: application/json" \
-d '{ "comments": [] }'
```

- This repo includes a `caching-test.js` script for quickly demonstrating and validating the caching behavior. Give it a try with `node caching-test.js` (component must be running with Harper).

## Tests

Integration tests live in `integrationTests/` and run against a real, ephemeral Harper instance via [`@harperfast/integration-testing`](https://www.npmjs.com/package/@harperfast/integration-testing). They cover the SSR render path (`UncachedBlog` / `CachedBlog`), Harper's multi-tier caching on the `BlogCache` table (conditional-request 304 cache hits and source-invalidation), and the `Post` REST API.

```sh
npm run test:integration
```

The `pretest:integration` script builds the app first (Harper serves the Vite SSR output from `dist/`). On macOS/Windows, running the tests requires loopback aliases (`npx harper-integration-test-setup-loopback`); on Linux they run as-is. CI runs the suite on Node 22, 24, and 26 via GitHub Actions.
