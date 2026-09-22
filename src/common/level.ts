/** The directory each vanilla dimension uses, relative to the level root. */
export const vanillaDimensions = {
	'minecraft:overworld': '',
	'minecraft:the_nether': 'DIM-1',
	'minecraft:the_end': 'DIM1',
} as const;

export const vanillaIds = new Map<string, string>(
	Object.entries(vanillaDimensions)
		.filter(([, dir]) => dir)
		.map(([id, dir]) => [dir, id]),
);

/** The subdirectories a dimension splits its region files across, all on the same grid. */
export const regionKinds = ['region', 'entities', 'poi'] as const;

export type RegionKind = (typeof regionKinds)[number];

/** A region file's coordinates and location on disk. */
export interface RegionFile {
	kind: RegionKind;
	/** Region coordinates. */
	x: number;
	z: number;
	name: string;
	path: string;
}

/** A id (e.g. for dimensions) with its namespace made explicit, so ids from different sources compare equal. */
export function normalizeId(id: string): string {
	const lower = id.toLowerCase();
	return lower.includes(':') ? lower : `minecraft:${lower}`;
}
