Optimize your Actor startup time by choosing the right packages and memory settings.

This Actor measures the time it takes from Node.js process start to the point when your main script starts executing, that's when Apify SDK, Crawlee and your own code start being executed (you see `System info` in the log). For short running Actors, this startup time can represent a significant portion of the total execution time, so optimizing it can lead to cost savings and better latency for users.

## How it works
- Add `dependencies` from your `package.json` to the input. You can specify versions or just use `*` for any new package.
- Specify different memory configurations to test. For short running Actors, the most common settings are between 128 MB and 1024 MB.
- Optionally, enable bundling with `@vercel/ncc` to see how much it improves startup time. In my experience, it is about 30% faster.
- Once you start this Actor, it will create a temporary Actor on your account and run it many times (50x by default) to get average startup times. These runs finish immediately so it should not incur any significant costs. At the end, it will delete the temporary Actor.

## Expected startup times
Based on my experiments, here are some expected startup times for different packages:
- Plain Node.js: ~30ms
- `apify`: ~500ms (Apify SDK imports lot of Crawlee code)
- `apify` + `@crawlee/cheerio`: ~600ms
- `apify` + `@crawlee/playwright` + `playwright`: ~1000ms
- `apify` + `crawlee`: ~1100ms