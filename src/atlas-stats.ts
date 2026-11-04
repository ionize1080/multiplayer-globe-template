import type {AtlasRecord} from './atlas';
import type {BioGroup} from './taxonomy';
export type AtlasBounds={west:number;south:number;east:number;north:number};
export type SpeciesRow={key:number;name:string;chineseName:string;count:number;group:BioGroup};
export type AtlasStats={rows:SpeciesRow[];totalRecords:number;offset:number;hasMore:boolean;fetchedAt:string;partial:boolean};
export type RecordPage={records:AtlasRecord[];total:number;hasMore:boolean};
export function boundsGeometry(b:AtlasBounds){const ring=(w:number,e:number)=>`${w} ${b.south},${e} ${b.south},${e} ${b.north},${w} ${b.north},${w} ${b.south}`;return b.west<b.east?`POLYGON ((${ring(b.west,b.east)}))`:`MULTIPOLYGON (((${ring(b.west,180)})),((${ring(-180,b.east)})))`;}
