import sample from "../fixtures/sample.json";
import type { MapData } from "../types";

export const SAMPLE = sample as unknown as MapData;

// what a load comes back with: the build, the sample standing in for it in
// dev, or nothing at all and the reason, which is what a deployed page gets
// when the request fails. a dropped connection is not an answer, so the
// deployed page says so and offers to try again rather than drawing the three
// metro fixture as if it were the map
export type LoadResult =
  | { data: MapData; sample: boolean; error?: undefined }
  | { data: null; sample: false; error: string };

// the built json is optional in dev. when it is missing there the sample
// keeps the app usable and the header says so
export async function loadMapData(dev: boolean = import.meta.env.DEV): Promise<LoadResult> {
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}data/metros.json`);
    if (!response.ok) throw new Error(`the server answered ${response.status}`);
    const data = (await response.json()) as MapData;
    if (!Array.isArray(data?.metros)) throw new Error("the file is not a map build");
    return { data, sample: false };
  } catch (error) {
    if (dev) return { data: SAMPLE, sample: true };
    return { data: null, sample: false, error: error instanceof Error ? error.message : String(error) };
  }
}
