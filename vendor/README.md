# Vendored QueryHost package

`queryhost-0.0.0.tgz` is the npm package artifact consumed by this private API deployment. It was packed from library commit `a12438926bc9aa4d338b17e8c02831cba8ad31e0` after `npm run verify` passed.

SHA-256:

```text
846CDCD30E22AE3C357759E081D23E7EBA81C1C3B6C8649229A4FC847E7EE35D
```

To refresh it, verify a clean sibling `query` checkout, remove the old tarball, and run:

```bash
npm pack ../query --pack-destination vendor
npm install
npm run verify
```

Update this file with the source commit and new SHA-256. Replace the tarball dependency with the ordinary npm version when the library is published.
