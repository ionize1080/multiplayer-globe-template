export type BioGroup='unknown'|'bird'|'mammal'|'insect'|'arachnid'|'fish'|'reptile'|'amphibian'|'mollusc'|'crustacean'|'flower'|'grass'|'conifer'|'fern'|'moss'|'algae'|'plant';
export const groupNames:Record<BioGroup,string>={unknown:'其他动物 / 分类待定',bird:'鸟类',mammal:'哺乳类',insect:'昆虫',arachnid:'蛛形类',fish:'鱼类',reptile:'爬行类',amphibian:'两栖类',mollusc:'软体动物',crustacean:'甲壳类',flower:'开花植物',grass:'禾草类',conifer:'裸子植物',fern:'蕨类',moss:'苔藓类',algae:'藻类',plant:'其他植物 / 分类待定'};
export function normalizeTaxonomy(r:any){
 const out={...r};const classifications=r.classifications||{};
 const backbone=classifications['d7dddbf4-2cf0-4f39-9b2a-bb099caae36c']||Object.values(classifications)[0] as any;
 for(const t of backbone?.classification||[]){const rank=String(t.rank).toLowerCase();if(['kingdom','phylum','class','order','family','genus','species'].includes(rank)){out[rank] ||= t.name;const key=Number(t.key);if(Number.isSafeInteger(key)&&key>0)out[rank+'Key'] ||= key;}}
 out.scientificName ||= backbone?.usage?.name;out.taxonKey ||= Number(backbone?.usage?.key)||undefined;
 return out;
}
export function bioGroup(input:any,layer:string):BioGroup{
 const r=normalizeTaxonomy(input),c=String(r.class||'').trim().toLowerCase(),p=String(r.phylum||'').toLowerCase(),o=String(r.order||'').toLowerCase(),f=String(r.family||'').toLowerCase();
 if(layer==='plants'){
  if(['poaceae','cyperaceae','juncaceae'].includes(f))return 'grass';
  if(['pinopsida','cycadopsida','ginkgoopsida','gnetopsida'].includes(c)||['pinales','cupressales','cycadales','ginkgoales','gnetales'].includes(o))return 'conifer';
  if(['polypodiopsida','pteridopsida','equisetopsida','lycopodiopsida','psilotopsida'].includes(c)||['pteridophyta','lycopodiophyta'].includes(p))return 'fern';
  if(['bryophyta','marchantiophyta','anthocerotophyta'].includes(p)||['bryopsida','sphagnopsida','marchantiopsida','jungermanniopsida','anthocerotopsida'].includes(c))return 'moss';
  if(['chlorophyta','rhodophyta','charophyta','glaucophyta'].includes(p))return 'algae';
  if(['magnoliopsida','liliopsida'].includes(c)||['magnoliophyta','anthophyta'].includes(p))return 'flower';return 'plant';
 }
 if(c==='aves')return 'bird';if(c==='mammalia')return 'mammal';
 if(c==='insecta'||['lepidoptera','coleoptera','diptera','hymenoptera','hemiptera','orthoptera','odonata','blattodea','mantodea','phasmatodea','neuroptera','trichoptera','ephemeroptera','plecoptera'].includes(o))return 'insect';
 if(c==='arachnida')return 'arachnid';if(['actinopterygii','actinopteri','elasmobranchii','chondrichthyes','sarcopterygii','myxini','petromyzonti'].includes(c)||['perciformes','gobiiformes','cypriniformes','siluriformes','salmoniformes','clupeiformes','anguilliformes','carcharhiniformes','lamniformes','syngnathiformes','tetraodontiformes'].includes(o))return 'fish';
 if(['reptilia','sauropsida','squamata','testudines','crocodylia'].includes(c)||['squamata','testudines','crocodylia'].includes(o))return 'reptile';if(c==='amphibia')return 'amphibian';
 if(p==='mollusca')return 'mollusc';if(['malacostraca','branchiopoda','ostracoda','maxillopoda','thecostraca','copepoda'].includes(c))return 'crustacean';return 'unknown';
}
