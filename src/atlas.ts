export type AtlasLayer='climate'|'landform'|'minerals'|'plants'|'animals';
export type AtlasClass={id:number;code:string;name:string;color:string;description:string};
const climateRows=[
 ['Af','热带雨林','#176c58'],['Am','热带季风','#2c9670'],['Aw','热带草原','#a5c65b'],
 ['BWh','热带沙漠','#e2a050'],['BWk','温带沙漠','#d6bb85'],['BSh','热带半干旱','#edd277'],['BSk','温带半干旱','#d5d995'],
 ['Csa','地中海 · 炎夏','#d8ad5e'],['Csb','地中海 · 暖夏','#b9c978'],['Csc','地中海 · 凉夏','#9cb99a'],
 ['Cwa','冬干温带 · 炎夏','#81bb7a'],['Cwb','冬干温带 · 暖夏','#5d9e8b'],['Cwc','冬干温带 · 凉夏','#438c90'],
 ['Cfa','湿润温带 · 炎夏','#6fc9ab'],['Cfb','湿润温带 · 暖夏','#4cafbe'],['Cfc','湿润温带 · 凉夏','#4192ad'],
 ['Dsa','夏干冷温带 · 炎夏','#b695c9'],['Dsb','夏干冷温带 · 暖夏','#9571b9'],['Dsc','夏干亚寒带','#775a9b'],['Dsd','夏干极寒冬','#584577'],
 ['Dwa','冬干冷温带 · 炎夏','#96ade0'],['Dwb','冬干冷温带 · 暖夏','#788dce'],['Dwc','冬干亚寒带','#5c70b8'],['Dwd','冬干极寒冬','#4d538e'],
 ['Dfa','湿润冷温带 · 炎夏','#92c8e2'],['Dfb','湿润冷温带 · 暖夏','#6aadd2'],['Dfc','湿润亚寒带','#477fb5'],['Dfd','湿润极寒冬','#345780'],
 ['ET','苔原','#bac7cb'],['EF','冰原','#edf3f4']
];
function climateDescription(code:string){
 const special:Record<string,string>={Af:'各月平均气温均不低于 18°C，最干月降水仍不少于 60 mm。',Am:'全年温暖，短暂干季；最干月降水低于 60 mm，但仍满足季风降水阈值。',Aw:'全年温暖，干季明显；降水低于雨林和季风型的分类阈值。',BWh:'年降水低于干旱阈值的一半，年均温不低于 18°C。',BWk:'年降水低于干旱阈值的一半，年均温低于 18°C。',BSh:'年降水介于干旱阈值的一半与阈值之间，年均温不低于 18°C。',BSk:'半干旱气候，年均温低于 18°C；并不意味着冬季处处严寒。',ET:'最暖月均温介于 0°C 与 10°C 之间，植物生长季短。',EF:'最暖月均温低于 0°C，全年气候寒冷。'};
 if(special[code])return special[code];
 const moisture=code[1]==='s'?'夏季干燥，冬季相对多雨。':code[1]==='w'?'冬季干燥，夏季相对多雨。':'无达到分类阈值的明显干季。';
 const heat=code[2]==='a'?'最暖月均温至少 22°C。':code[2]==='b'?'最暖月低于 22°C，至少 4 个月均温超过 10°C。':code[2]==='d'?'暖季很短，最冷月均温低于 −38°C。':'仅 1–3 个月均温超过 10°C。';
 return (code[0]==='C'?'温带：最冷月均温在 0°C 至 18°C 之间。':'冷温带：最冷月均温不高于 0°C，至少一个月达到 10°C。')+moisture+heat;
}
export const climateClasses:AtlasClass[]=climateRows.map(([code,name,color],i)=>({id:i+1,code,name,color,description:climateDescription(code)}));
export const landformClasses:AtlasClass[]=[
 {id:1,code:'Flat',name:'平坦地',color:'#a8bb9b',description:'周围多个方向的地表高差较小，局部起伏不明显；不等同于低海拔。'},
 {id:2,code:'Summit',name:'峰顶',color:'#f4dfbd',description:'相对周边各方向较高的局部地形顶点，可出现在山峰或小丘顶部。'},
 {id:3,code:'Ridge',name:'山脊',color:'#b77165',description:'沿一个方向延伸、两侧地势下降的凸起地形。'},
 {id:4,code:'Shoulder',name:'坡肩',color:'#d99566',description:'平缓的上部地形向较陡坡面过渡的凸形地带。'},
 {id:5,code:'Spur',name:'支脊',color:'#d9bc64',description:'从主山脊或山体向外伸出的次级凸起，多位于沟谷之间。'},
 {id:6,code:'Slope',name:'坡面',color:'#c5ce75',description:'上坡方向较高、下坡方向较低的倾斜地表，不直接表示坡度大小。'},
 {id:7,code:'Hollow',name:'坡凹',color:'#79bfa1',description:'坡面上的局部凹入地带，常有汇流趋势；不一定存在河流。'},
 {id:8,code:'Footslope',name:'坡麓',color:'#54aaa9',description:'较陡坡面向下部平缓地表过渡的凹形地带。'},
 {id:9,code:'Valley',name:'谷地',color:'#699fcb',description:'两侧地形相对较高、沿某一方向延伸的低地，包括有水或无水谷地。'},
 {id:10,code:'Depression',name:'洼地',color:'#786b9e',description:'周边多个方向较高的局部低点；不等同于湖泊、积水或封闭盆地。'}
];
export const atlasMeta:Record<AtlasLayer,{name:string;en:string;accent:string;precision:string;summary:string;note:string;source:string;url:string}>={
 climate:{name:'全球气候带',en:'CLIMATE REGIONS',accent:'#82d4bf',precision:'约 1 km · 1991–2020',summary:'从雨林到冰原，用长期温度与降水认识 30 种柯本–盖格气候。',note:'30 年气候平均分类，不是今日天气。缩放不会提高原始数据分辨率。',source:'Beck et al. 2023 · Esri Living Atlas',url:'https://www.gloh2o.org/koppen/'},
 landform:{name:'地貌形态',en:'LANDFORM PATTERNS',accent:'#d8bb87',precision:'约 30 m · 实验性数据',summary:'观察地表的峰、脊、谷、坡：从周围地势的高低关系识别 10 类局部形态。',note:'GEDTM30 首版派生分类，仅作探索参考；不是地质成因图。南极及源数据空缺区域不着色。',source:'OpenGeoHub · GEDTM30 v20241230',url:'https://doi.org/10.5281/zenodo.14920357'},
 minerals:{name:'矿产资源',en:'MINERAL RECORDS',accent:'#edbd6b',precision:'矿床 / 矿点级 · 历史记录',summary:'探索全球已收录的金属与非金属资源，查看矿点名称、矿种和原始档案。',note:'MRDS 于 2011 年停止系统更新；记录不代表现有产量、可开采储量或当前开采状态。',source:'USGS · Mineral Resources Data System',url:'https://mrdata.usgs.gov/mrds/'},
 plants:{name:'植物观察',en:'BOTANICAL OBSERVATIONS',accent:'#95d795',precision:'物种 / 观测点级',summary:'从全球记录密度到一株植物的观测，认识当地植物与它们被记录的时间。',note:'观测记录不是完整分布范围。空白可能只是缺少调查；记录数量不等于个体数量。',source:'GBIF · 原始数据发布者见记录',url:'https://www.gbif.org/'},
 animals:{name:'动物观察',en:'FAUNAL OBSERVATIONS',accent:'#e9a990',precision:'物种 / 观测点级',summary:'探索鸟类、哺乳类、昆虫与海洋生物的公开观测记录。',note:'位置误差和调查强度因记录而异；历史观测不能保证现在仍可见该物种。',source:'GBIF · 原始数据发布者见记录',url:'https://www.gbif.org/'}
};
export const animalGroups=[{key:1,name:'全部动物',icon:'animals'},{key:212,name:'鸟类',icon:'bird'},{key:359,name:'哺乳类',icon:'mammal'},{key:216,name:'昆虫',icon:'insect'},{key:204,name:'辐鳍鱼类',icon:'fish'}];
export const mineralGroups=[{key:'all',name:'全部矿种'},{key:'AU',name:'金'},{key:'CU',name:'铜'},{key:'FE',name:'铁'},{key:'AG',name:'银'},{key:'LI',name:'锂'},{key:'REE',name:'稀土'},{key:'CO',name:'钴'},{key:'NI',name:'镍'}];
export const mineralNames:Record<string,string>={AU:'金',AG:'银',CU:'铜',FE:'铁',PB:'铅',ZN:'锌',NI:'镍',CO:'钴',LI:'锂',MN:'锰',AL:'铝',BA:'钡',U:'铀',W:'钨',SN:'锡',MO:'钼',CR:'铬',PT:'铂',REE:'稀土',P:'磷',C:'碳',S:'硫',HG:'汞',SB:'锑',TI:'钛',V:'钒',AU_P:'砂金',SDG:'建筑砂砾',DIT:'硅藻土',GEO:'地热',PGE_PT:'铂',PGE:'铂族元素',COA:'煤',CLY:'黏土',STN:'石材',STN_C:'碎石',LST:'石灰岩',SIL:'硅质原料',QTZ:'石英',B:'硼及硼酸盐',F:'氟及萤石',GEM:'宝石'};
export type AtlasRecord={id:string;layer:AtlasLayer;name:string;lat:number;lon:number;kind:string;detail:string;url:string;date?:string;uncertainty?:number;publisher?:string;license?:string;quality?:string;generalized?:boolean;scientificName?:string;group?:import('./taxonomy').BioGroup;speciesKey?:number};
export type AtlasRecords={records:AtlasRecord[];total:number|null;truncated:boolean;fetchedAt:string};
export function validAtlasLayer(s:string):s is AtlasLayer{return ['climate','landform','minerals','plants','animals'].includes(s);}
export function geographicTile(z:number,x:number,y:number){if(![z,x,y].every(Number.isInteger)||z<0||z>14||x<0||x>=2**(z+1)||y<0||y>=2**z)return null;const span=180/2**z;return {west:-180+x*span,east:-180+(x+1)*span,north:90-y*span,south:90-(y+1)*span};}
export function splitBounds(w:number,s:number,e:number,n:number):number[][]{if(![w,s,e,n].every(Number.isFinite)||w< -180||w>180||e< -180||e>180||s< -90||n>90||s>=n||w===e)return [];return w<e?[[w,s,e,n]]:[[w,s,180,n],[-180,s,e,n]].filter(b=>b[0]<b[2]);}
export const climateResolution=(level:number)=>0.00833330000000387*2**(7-level);
export const LAND_COG='https://s3.opengeohub.org/global/dtm/v3/geomorphon_edtm_m_30m_s_20000101_20221231_go_epsg.4326_v20241230.tif';
export const CLIMATE_SERVICE='https://tiledimageservices.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/Koppen_Geiger_Climate_Classification/ImageServer';
export const MINERAL_SERVICE='https://services.arcgis.com/v01gqwM5QqNysAAi/arcgis/rest/services/Mineral_Resources_Data_System_MRDS_Compact_Version/FeatureServer/0';
