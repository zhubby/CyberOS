These public test fixtures exercise HTTP, HTTPS and SOCKS5 proxy connections in
the TypeScript API and Rust indexer tests. The private key is deliberately public
and belongs only to this test server. Runtime services never load these files.
The certificate includes local and TMDB hostnames so tests can route fixed TMDB
URLs through an isolated local proxy without contacting the internet.
