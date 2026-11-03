# Satellite exploration and IONACS sign-in

The public rotating globe remains available without signing in. Its real sunlight mode displays the approximately 23.44 degree axial tilt, a cyan polar axis and the current UTC time. The geographic sun vector is transformed with the display rotation, preserving the current geographic day/night boundary as the globe turns. The solar approximation follows https://aa.usno.navy.mil/faq/sun_approx; this is a visualization, not a navigation ephemeris.

Free exploration requires an existing IONACS mailbox identity. `/auth/login` creates a 10-minute, Secure/HttpOnly host-only state cookie and redirects to `ionacs.com`. The navigation app performs its existing password and Turnstile checks. It returns a 120-second, single-use code with a fixed `https://ionize.club/auth/callback` destination. The callback checks browser state before atomically consuming the code. The resulting host-only session lasts 24 hours and is checked against the original navigation session and mailbox password version on each protected request. Navigation logout and password changes revoke access. Logout requires a same-origin POST. No mailbox password is submitted to this application.

## Release order

1. In `ionize1080/ionacs-navigation`, deploy through the existing `npm run deploy` workflow. It applies additive migration `0004_globe_sso.sql` and releases the authorization endpoint and login continuation.
2. Verify the existing Worker account, domain and deployment settings before deploying this repository. `wrangler.json` adds the `MAIL_DB` binding to the same existing `maildata` D1 database. It does not create a mailbox or change a password.
3. Before deploying the immersive explorer update, apply the additive shared-cache schema with `npx wrangler d1 execute MAIL_DB --remote --file migrations/0001_weather_cache.sql`. This creates only globe weather tables; existing mailbox data is unchanged.
4. Run `npm ci`, `npm test`, `npm run check`, then the existing authorized `npm run deploy` workflow. The build copies Cesium's worker/assets locally and splits the explorer into a lazy-loaded module.
5. Verify a real login, return to exploration, logout and unauthenticated `/api/globe/weather` rejection on production. Do not seed local test identities in the production database. The preview configuration uses a placeholder isolated database and cannot perform production SSO.

## Data and limits

- CesiumJS renders Esri World Imagery with its provider attribution. No Google API or Google billing account is used. The data provider's terms and availability still apply. Imagery is archival, not live, and coverage/resolution varies. Zoom is bounded by available imagery (level 19) and a 100 m camera-height floor; it is not infinite detail. There are no photorealistic 3D buildings or terrain-height data in this version.
- Cloud imagery reuses EUMETSAT / Live Cloud Maps, with publication cadence around three hours. Publication time is not observation time. Some polar coverage is absent. Existing public decorative/overview clouds are unchanged.
- Temperature and 10 m wind use Open-Meteo current model data. A fixed 264-point, 15-degree global grid is shared across users and regions in D1 for three hours; browsers check every 15 minutes. Color interpolation is visual only. Wind arrows show downwind direction. The displayed timestamp is the model-valid time, not fetch time. With any weather layer enabled, clicking queries Open-Meteo separately for that location using its available local model. Ten current parameters are returned, including apparent temperature, humidity, gusts, pressure and precipitation. Model cell coordinates and valid time are displayed. Coordinates are rounded to 0.01 degrees for a shared 30-minute cache; this does not imply 0.01-degree source resolution. This first version does not supply street-level weather, a forecast time slider or animated wind particles.
- Open-Meteo's free endpoint is for non-commercial use and has request limits: https://open-meteo.com/en/pricing . Multiple locations count toward usage. Shared D1 counters cap explorer upstream usage at 550/minute, 4,400/hour and 8,000/day, counting every location in a grid request. Point-query cache misses additionally cap each signed-in user at 10/minute and 400/day. Cache hits are reused across users, and an atomic refresh lease prevents concurrent duplicate fetches. These budgets cover explorer requests, not unrelated clients of the same provider. Signing in and caching do not remove the free endpoint’s non-commercial restriction.

## Validation

`npm test` includes actual local D1 tests for mismatched state, concurrent code replay, anonymous access, cross-origin logout, navigation-session revocation and mailbox password changes, plus solar-solstice and rotation-invariance checks. Navigation has a separate test for guest redirection and fixed callback enforcement. Browser previews must use isolated synthetic identities only.

## Immersive layout and reference layers

Exploration fills the viewport and hides clocks, markets and rotation controls. The exit button or Escape restores the rotating dashboard. Weather details reserve a 340 px desktop column or a separate bottom region on narrow screens; the map resizes and recenters the selected location instead of putting a card over it.

Clouds, temperature, wind arrows, geographic features and place labels have independent switches. When temperature and wind are both enabled, the color field shows temperature and arrow color shows wind speed. Natural Earth v5.1.2 supplies public-domain country-level reference boundary lines (1:50m) and city labels, bundled as small static assets. Labels appear by scale rank as the camera approaches. These are generalized reference data, not street labels or cadastral boundaries. Satellite imagery remains provider-hosted.

All map positions use WGS84. Natural Earth vectors use WGS84 longitude/latitude directly; Esri imagery uses the WGS84 Web Mercator system. No GCJ-02 or BD-09 offsets are applied. Adding a domestic offset map provider later requires explicit datum conversion at its boundary. Reference boundaries reflect the source dataset and are not a bespoke authoritative boundary product.

Current cache payloads are small JSON records with expired-row cleanup. AWS or Oracle storage can be considered if a future release stores high-resolution weather rasters; neither service is provisioned or required by this release.

Weather cache tests use actual isolated D1 storage and cover shared reuse, concurrent refresh exclusion, provider budget rejection and coordinate validation.
