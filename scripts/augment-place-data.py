"""Add GeoNames cities15000 to Natural Earth shards; run after build-reference-data.
Usage: python3 scripts/augment-place-data.py /path/to/cities15000.zip
Source: https://download.geonames.org/export/dump/ (CC BY 4.0).
"""
import sys,json,zipfile,math,re,hashlib
from pathlib import Path
from datetime import date
root=Path(__file__).resolve().parents[1]/'public/data/reference'
shards={p.stem.removesuffix('.places'):[r for r in json.loads(p.read_text()) if r.get('source')!='geonames'] for p in root.glob('*.places.json')}
buckets={}
names={}
for rows in shards.values():
 for r in rows:
  if r.get('kind')=='city':names.setdefault(r['name'].casefold(),[]).append(r)
  if r.get('kind')=='city':buckets.setdefault((math.floor(r['lon']/.05),math.floor(r['lat']/.05)),[]).append(r)
added=0
with zipfile.ZipFile(sys.argv[1]) as archive:
 for line in archive.read('cities15000.txt').decode().splitlines():
  f=line.split('\t');lat,lon=float(f[4]),float(f[5]);pop=int(f[14] or 0);bx,by=math.floor(lon/.05),math.floor(lat/.05)
  if any(abs(r['lat']-lat)<.025 and abs(r['lon']-lon)<.025 for x in range(bx-1,bx+2) for y in range(by-1,by+2) for r in buckets.get((x,y),[])):continue
  aliases={v.casefold() for v in [f[1],f[2],*f[3].split(',')]}
  if any(abs(r['lat']-lat)<.3 and abs(r['lon']-lon)<.3 for name in aliases for r in names.get(name,[])):continue
  name=f[1]
  if f[8] in ('CN','TW','HK','MO'):
   chinese=[v for v in f[3].split(',') if re.fullmatch(r'[\u3400-\u9fff·]+',v)]
   if chinese:name=chinese[0]
  rank=3 if pop>=2000000 else 4 if pop>=500000 else 6 if pop>=100000 else 8 if pop>=30000 else 9
  key=f'{min(17,math.floor((lon+180)/20))}-{min(8,math.floor((lat+90)/20))}'
  shards.setdefault(key,[]).append(dict(name=name,lat=round(lat,5),lon=round(lon,5),rank=rank,kind='city',source='geonames'))
  added+=1
for key,rows in shards.items():
 target=root/(key+'.places.json')
 if not target.exists() or json.loads(target.read_text())!=rows:target.write_text(json.dumps(rows,ensure_ascii=False,separators=(',',':'))+'\n')
 if not (root/(key+'.json')).exists():(root/(key+'.json')).write_text('{"type":"FeatureCollection","features":[]}\n')
manifest=json.loads((root/'index.json').read_text());manifest.update(version='ne-5.1.2-geonames-'+date.today().isoformat(),tiles=sorted(shards))
(root/'index.json').write_text(json.dumps(manifest,separators=(',',':'))+'\n')
(root/'geonames-source.json').write_text(json.dumps(dict(source='GeoNames cities15000',url='https://download.geonames.org/export/dump/cities15000.zip',license='CC BY 4.0',date=date.today().isoformat(),sha256=hashlib.sha256(Path(sys.argv[1]).read_bytes()).hexdigest(),added=added),indent=2)+'\n')
print(f'Added {added} places across {len(shards)} shards')
