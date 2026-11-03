export type PointWeather={source:string;temperatureKind:string;downscaling:string;time:string;sampleLatitude:number;sampleLongitude:number;current:Record<string,number|string|null>;units:Record<string,string>;fetchedAt:string};
export function weatherLocation(lat:number,lon:number){
 if(!Number.isFinite(lat)||!Number.isFinite(lon)||Math.abs(lat)>90||Math.abs(lon)>180)return null;
 const latitude=Number(lat.toFixed(4)),longitude=Number(lon.toFixed(4));
 return {lat:latitude,lon:longitude,key:`point-native-v3:${latitude}:${longitude}`};
}
export type NativeWeatherPoint={lat:number;lon:number;weather:PointWeather};
export const POINT_WEATHER_TTL=15*60000;
