// Keep the map entry independent of the live dashboard and its background polling.
if(location.hostname==='map.ionize.club')void import('./map');
else void import('./index');
