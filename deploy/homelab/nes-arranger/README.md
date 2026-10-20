# Homelab deployment of the song server

These manifests deploy the song server (`server/`, spec 005) to the student's homelab at
`https://nes-arranger-bh.giow.dev`. They follow the conventions of
`GiowGiow/homelab-kubernetes-server` and are a deployable copy: ArgoCD reads the homelab
repository, not this one.

| File | What it holds |
|---|---|
| `namespace.yaml` | namespace `nes-arranger` |
| `deployment.yaml` | 1 replica of `ghcr.io/giowgiow/nes-arranger-server`, non-root, read-only root filesystem, `/tmp` as an `emptyDir`, probes on `/health`, requests 50m/128Mi, limits 500m/512Mi |
| `service.yaml` | port 8765 |
| `network-policy.yaml` | ingress only from `traefik-system` and `gatus` on 8765; egress only DNS and HTTPS to public addresses (10/8, 172.16/12, 192.168/16, 100.64/10 and 169.254/16 excluded) |
| `ingress-external.yaml` | `nes-arranger-bh.giow.dev` through the FRP relay and Cloudflare, zone wildcard TLS, crowdsec, redirect, rate-limit and secure-headers middlewares, no forward-auth, Gatus check on `/health` |
| `kustomization.yaml` | the list above |

## Status and what to change before deploying (2026-10-20)

Not deployed. The published page works without the server (`PRODUCTION_SERVER_LIVE = false` in
`arranger/src/core/sources.js`). Findings from reading the homelab's documentation and cluster:

- **No image registry is needed.** The homelab runs its own code as a stock image plus a clone of
  the git repository (`kustomize/docs`, `kustomize/autobuy`): a `git-sync` init container clones
  this public repository at a pinned commit (no token), a `python:3.12-slim` init container runs
  `pip install --target` of the pinned server dependencies (`uv export --no-dev --group server
  --no-emit-project --no-hashes`) into an `emptyDir`, and the main container runs `uvicorn
  server.app:app` from the clone with `PYTHONPATH` on that directory. No `ghcr.io` pull secret
  exists in the cluster, so the image in `deployment.yaml` below, and the image workflow, are not
  the way to deploy. The `Dockerfile` stays for a local check.
- Add `priorityClassName: homelab-low` and the Glance annotations (`glance/name`, `glance/icon`,
  `glance/url`) to the Deployment, as the homelab rules ask.
- The namespace `nes-arranger` must be added to the `services` AppProject destinations
  (`argo-apps/projects.yaml`) in a commit before the service's own commit.
- The cluster was in a temporary low-memory profile for an 8 GB test (commit f24a856 of the homelab
  repository, 16 October 2026): memory requests were at 92 percent and ExternalDNS was paused, so
  neither the Cloudflare record nor the Pi-hole address of a new host is created. Deploy after that
  test ends, and add the Pi-hole `local=` line only once the A record exists.
- A Cloudflare rule ("Misc Blocks", per the homelab notes) blocks countries other than BR, HU and
  TW; a skip rule for this host is the owner's to create if visitors from elsewhere should reach it.

## Steps

Pushing to the homelab repository needs the student's explicit approval at that time (task T053).

1. Push the server to `main` of this repository. The workflow `.github/workflows/server-image.yml`
   tests it and pushes `ghcr.io/giowgiow/nes-arranger-server:<sha>` and `:main`. The first push
   creates the package as private: make it public once in the package settings, or add an image
   pull secret to the namespace.
2. Pin the image by digest in `deployment.yaml`:

   ```bash
   docker buildx imagetools inspect ghcr.io/giowgiow/nes-arranger-server:main
   ```

   then write `image: ghcr.io/giowgiow/nes-arranger-server@sha256:<digest>`.
3. Copy this folder to `kustomize/nes-arranger/` in `GiowGiow/homelab-kubernetes-server`. The
   `services` ApplicationSet discovers every `kustomize/*` folder, so no Application is needed.
4. In the same commit, edit the two shared files that every public `*-bh` host needs:
   - `kustomize/frp-client/configmap.yaml`: add `"nes-arranger-bh.giow.dev"` to the single
     `customDomains` list of the `mk3_https` proxy. Without it the relay never forwards the host.
   - `kustomize/pihole/05-custom-dns.conf`: add the line `local=/nes-arranger-bh.giow.dev/` next to
     the other `-bh` hosts.
5. Also in that commit, record the exception in the homelab's `docs/security.md` (text below).
6. After ArgoCD syncs, check from outside the LAN:

   ```bash
   curl -s https://nes-arranger-bh.giow.dev/health
   curl -si -X OPTIONS https://nes-arranger-bh.giow.dev/search \
     -H 'Origin: https://giowgiow.github.io' -H 'Access-Control-Request-Method: GET'
   curl -s 'https://nes-arranger-bh.giow.dev/search?q=waltz' | head -c 300
   ```

   The preflight must answer 200 with `access-control-allow-origin: https://giowgiow.github.io`
   (check that the secure-headers middleware keeps the CORS headers). The private-address
   refusal is covered by the server's tests and by the egress policy; a pod shell check is
   `kubectl -n nes-arranger exec deploy/nes-arranger -- python -c "import urllib.request;
   urllib.request.urlopen('http://192.168.0.1', timeout=3)"`, which must time out.

## Note for the homelab `docs/security.md`

```markdown
### Public API without OAuth: nes-arranger-bh.giow.dev

The NES arranger song server is public on purpose. The arranger page on GitHub Pages calls it
from visitors' browsers, and visitors have no accounts, so forward-auth would break it. It is
read-only (GET only), stateless, and holds no secrets or personal data.

- Traefik: crowdsec bouncer, redirect to HTTPS, rate limit and secure headers.
- The app: CORS only for https://giowgiow.github.io; per-IP limits (60 requests a minute, 20 of
  them searches); four allow-listed upstream sites over HTTPS, with a 2 MB and 10 s cap per
  fetch; every resolved address must be public; a takedown denylist; no access log.
- The pod: non-root, read-only root filesystem, no service account token, and an egress policy
  that allows only DNS and port 443 outside 10/8, 172.16/12, 192.168/16, 100.64/10 and 169.254/16.
```

## Rate limits and client addresses

The server keys its per-visitor limits on the first address of `X-Forwarded-For`. Behind
Cloudflare, the FRP relay (PROXY protocol v2) and Traefik, that is the visitor only when Traefik
trusts the forwarded headers it receives; otherwise every visitor arriving through one Cloudflare
edge shares a budget. Check one request's headers after the first deployment and adjust
`client_key` in `server/limits.py` if needed.
