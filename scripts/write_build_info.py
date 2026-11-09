#!/usr/bin/env python3
"""Write build-info.json — the weekly provenance record committed to the repo.

Reads provenance/artifact.sha256 (the full per-file manifest emitted by
scripts/build_web.sh). The weekly commit of this file doubles as the
repository activity that keeps the scheduled workflow from being disabled
for inactivity (GitHub's 60-day rule) — no keepalive action needed.
"""
import datetime
import hashlib
import json
import os
import sys

man_path = 'provenance/artifact.sha256'
if not os.path.isfile(man_path):
    sys.exit(f'missing {man_path} — run build_web.sh first')

blob = open(man_path, 'rb').read()
info = {
    'built_at_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'),
    'source': 'rustdesk/rustdesk@1.2.5 (7d56717cf56bc3535832e2a89e4a87c5ca753f1e)',
    'flutter': '3.19.6 (tarball sha256 db6742a20626d0d2a089eb41ad61b9b2138b996679911e9c8268c1f896191f97)',
    'artifact_files': sum(1 for _ in open(man_path)),
    'artifact_manifest_sha256': hashlib.sha256(blob).hexdigest(),
}
if os.environ.get('GITHUB_RUN_ID'):  # omit when generated outside CI
    info['run'] = (f"{os.environ.get('GITHUB_SERVER_URL', '')}/{os.environ.get('GITHUB_REPOSITORY', '')}"
                   f"/actions/runs/{os.environ['GITHUB_RUN_ID']}")
with open('build-info.json', 'w') as f:
    json.dump(info, f, indent=2)
    f.write('\n')
print(f"build-info.json: {info['artifact_files']} files, "
      f"manifest sha256 {info['artifact_manifest_sha256'][:16]}…")
