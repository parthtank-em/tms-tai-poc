# Route and Weather — Discussion Notes

## Q1

> does using google route api considers road block, weather into account ?

Partly. Here's what Google's **Routes API** (`computeRoutes`) takes into account. Note that we don't call it today: our route comes from Radar.

| Factor | Considered? | How |
|---|---|---|
| **Live traffic** | Yes, if you ask for it | Set `routingPreference` to `TRAFFIC_AWARE` or `TRAFFIC_AWARE_OPTIMAL`. With the default, `TRAFFIC_UNAWARE`, live traffic is ignored. |
| **Accidents and incidents** | Indirectly | They slow down traffic speeds, so a traffic-aware route avoids them and the ETA goes up. |
| **Road closures** | Mostly | Closures Google knows about (from its map data and live reports) are avoided. Brand-new or local closures may be missed until Google learns about them. |
| **Future traffic** | Yes | Pass a `departureTime` and Google uses typical traffic patterns for that day and time. |
| **Weather** | **No, not directly** | Weather is not an input. Rain or fog only matters if it actually slows traffic, which then shows up as slower live speeds. There's no "avoid flooded roads" or weather-based routing. |
| **Tolls, highways, ferries** | Yes, as options | `routeModifiers`: `avoidTolls`, `avoidHighways`, `avoidFerries`. |
| **Trucks** | **No** | Travel modes are drive, two-wheeler, bicycle, walk and transit. There is no truck mode, so height, weight and restricted truck roads aren't considered. |

**Compared with what we use now (Radar):**
- Radar's route API has a **truck mode**, which Google's Routes API doesn't.
- Radar doesn't document traffic-aware routing the way Google does, so treat Radar's time as a typical-conditions estimate.
- Neither one routes around weather.

**Practical takeaway**
- If accurate ETAs in traffic matter most, Google's Routes API with `TRAFFIC_AWARE` is the stronger choice, but it routes as a **car**.
- If truck-legal roads matter most, Radar's truck mode is the better fit, but without clear traffic awareness.
- For weather, you'd need a separate weather service. Neither routing API covers it.

I'm answering from Google's published API options, not from a test. If this decision matters, check Google's current Routes API docs, since features change.

---

## Q2

> I am not able to read. Copy paste what you have said below

Google's Routes API (computeRoutes): what it takes into account. We don't use it today; our route comes from Radar.

1. Live traffic: YES, if you ask for it.
   Set routingPreference to TRAFFIC_AWARE or TRAFFIC_AWARE_OPTIMAL. The default, TRAFFIC_UNAWARE, ignores live traffic.

2. Accidents and incidents: INDIRECTLY.
   They slow traffic down, so a traffic-aware route avoids them and the ETA goes up.

3. Road closures: MOSTLY.
   Closures Google knows about (from its map data and live reports) are avoided. Brand-new or local closures may be missed until Google learns about them.

4. Future traffic: YES.
   Pass a departureTime and Google uses typical traffic for that day and time.

5. Weather: NO, not directly.
   Weather is not an input. Rain or fog only matters if it actually slows traffic, which then shows up as slower live speeds. There is no weather-based routing.

6. Tolls, highways, ferries: YES, as options.
   routeModifiers: avoidTolls, avoidHighways, avoidFerries.

7. Trucks: NO.
   Travel modes are drive, two-wheeler, bicycle, walk and transit. There is no truck mode, so truck height, weight and restricted roads are not considered.

Compared with what we use now (Radar):
- Radar's route API has a truck mode. Google's Routes API does not.
- Radar doesn't document traffic-aware routing the way Google does, so treat Radar's time as an estimate for typical conditions.
- Neither one routes around weather.

What this means:
- If accurate ETAs in traffic matter most, Google's Routes API with TRAFFIC_AWARE is the stronger choice, but it routes as a car.
- If truck-legal roads matter most, Radar's truck mode is the better fit, but without clear traffic awareness.
- For weather you would need a separate weather service. Neither routing API covers it.

This is from Google's published API options, not from a test. If this decision matters, check Google's current Routes API docs, since features change.

---

## Q3

> can I use google weather API for radar routing and for google routing both?

Yes, but only as a separate step. Neither routing API accepts weather as an input, so weather can't change the route that Radar or Google picks. What you can do is check the weather along the route and warn the driver or adjust the ETA yourself.

How it would work (same for Radar's route and Google's route):

1. Get the route.
   Radar or Google returns the route line, a list of latitude/longitude points, plus the travel time.

2. Pick a few points along the route.
   For example the start, every 20–30 km, and the destination. You don't need all 500 points.

3. Work out when the truck reaches each point.
   Use the departure time plus the share of the total travel time, for example the halfway point at about half the ETA.

4. Ask the Google Weather API about each point.
   Send its latitude/longitude and get the current conditions or the hourly forecast for the time the truck will be there (rain, wind, visibility, temperature).

5. Use the result.
   - Show warnings on the trip page, like "Heavy rain expected near Bharuch around 14:00".
   - Optionally add extra time to the ETA by your own rules, for example +10% in heavy rain.
   - Optionally show weather icons on the Google map.

Why it works with both:
The Weather API only needs latitude/longitude and a time. Radar's route and Google's route both give you that, so the same weather code works for either.

What it can't do:
- It can't make Radar or Google choose a different road because of weather. If you want to avoid bad weather, you would have to ask for alternative routes and pick one yourself based on the weather results.
- Any ETA change is your own estimate, not the routing API's.

Things to check before building:
- Cost: each weather lookup is a billed call. 5–10 points per trip is fine; checking all 500 points is not.
- Coverage: check that the Google Weather API covers India and gives the forecast detail you need, such as hourly.
- Terms: Google's terms limit using Google data together with non-Google services. Combining Google weather with a Radar route needs a check before production. With Google's own route there is no such concern.

Where it would fit in our POC:
- A small server function that takes the planned route, samples the points and calls the Weather API.
- Weather shown on the Preview card and the trip page.
- For an active trip, the weather could be refreshed from the phone's current position every so often.

I'm answering from what the Google Weather API generally offers, not from testing it with your key. If you want, I can first check that it works with your key for an India location.
