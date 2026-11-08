#!/bin/zsh
# Packs tools/Aerial Uploader.app into public/admin/downloads/AerialUploader.zip (served only to logged-in admins).
# Runs automatically before every deploy. ditto keeps the bundle's permissions intact on macOS.
set -e
cd "${0:A:h}/.."
out="public/admin/downloads/AerialUploader.zip"
mkdir -p "${out:h}"
rm -f "$out"
if command -v ditto >/dev/null; then
  ditto -c -k --sequesterRsrc --keepParent "tools/Aerial Uploader.app" "$out"
else
  (cd tools && zip -qry "../$out" "Aerial Uploader.app" -x '*.DS_Store')
fi
echo "Packed $(du -h "$out" | cut -f1) → $out"
