import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { parseSync } from "oxc-parser";

import type { Class, EcmaScriptModule, Program } from "oxc-parser";

const sourceExtensions = new Set([".ts", ".tsx"]);
const skipDirectoryNames = new Set([
	".git",
	".halo",
	".turbo",
	".vite",
	"build",
	"dist",
	"contract",
	"coverage",
	"dist",
	"node_modules",
	"out",
]);

type FileExports = {
	alwaysExported: Set<string>;
	local: Set<string>;
	namedReexports: Array<{
		exported: string;
		local: string;
		from: string;
	}>;
	namespaceReexports: Array<{ exported: string; from: string }>;
	starReexports: string[];
};

type ProjectGraph = {
	unusedByFile: Map<string, Set<string>>;
};

type PackageMap = {
	entries: Set<string>;
	specifiers: Map<string, string>;
};

let cached: { root: string; graph: ProjectGraph } | undefined;

export function unusedExportsByFile(filename: string): ReadonlyMap<string, ReadonlySet<string>> {
	const root = workspaceRoot(filename);
	if (cached === undefined || cached.root !== root) {
		cached = { root, graph: buildGraph(root) };
	}
	return cached.graph.unusedByFile;
}

export function unusedExportNames(filename: string): ReadonlySet<string> {
	return unusedExportsByFile(filename).get(normalize(filename)) ?? new Set();
}

function workspaceRoot(fromFile: string): string {
	let directory = dirname(fromFile);
	while (true) {
		if (existsSync(join(directory, "pnpm-workspace.yaml"))) return directory;
		const parent = dirname(directory);
		if (parent === directory) return dirname(fromFile);
		directory = parent;
	}
}

function buildGraph(root: string): ProjectGraph {
	const files = listSourceFiles(root);
	const packages = publicModules(root);
	for (const file of files) {
		if (isToolingEntryFile(file) || file.endsWith(`${sep}emptyNodeFs.ts`)) {
			packages.entries.add(file);
		}
	}
	const fileSet = new Set(files);
	const parsed = new Map<string, FileExports>();
	const importers = new Map<string, Array<{ names: string[]; star: boolean }>>();

	for (const file of files) {
		const source = readFileSync(file, "utf8");
		const parsedFile = parseSync(file, source);
		const record: FileExports = {
			alwaysExported: new Set(),
			local: new Set(),
			namedReexports: [],
			namespaceReexports: [],
			starReexports: [],
		};
		collectModule(parsedFile.module, parsedFile.program, file, fileSet, packages, record, importers);
		parsed.set(file, record);
	}

	const used = new Map<string, Set<string>>();
	const mark = (file: string, name: string, stack = new Set<string>()): void => {
		const key = `${file}::${name}`;
		if (stack.has(key)) return;
		stack.add(key);
		const names = used.get(file) ?? new Set();
		if (names.has(name)) return;
		const record = parsed.get(file);
		if (record === undefined) return;
		if (record.local.has(name)) {
			names.add(name);
			used.set(file, names);
			for (const namespace of record.namespaceReexports) {
				if (namespace.exported === name) markAll(namespace.from);
			}
			return;
		}
		for (const reexport of record.namedReexports) {
			if (reexport.exported !== name) continue;
			names.add(name);
			used.set(file, names);
			mark(reexport.from, reexport.local, stack);
			return;
		}
		for (const from of record.starReexports) {
			mark(from, name, stack);
			if (used.get(from)?.has(name) === true) {
				names.add(name);
				used.set(file, names);
				return;
			}
		}
	};
	const markAll = (file: string, stack = new Set<string>()): void => {
		if (stack.has(file)) return;
		stack.add(file);
		const record = parsed.get(file);
		if (record === undefined) return;
		for (const name of record.local) mark(file, name);
		for (const reexport of record.namedReexports) {
			mark(file, reexport.exported);
			mark(reexport.from, reexport.local);
		}
		for (const from of record.starReexports) markAll(from, stack);
	};

	for (const file of packages.entries) {
		if (parsed.has(file)) markAll(file);
	}
	for (const [file, requests] of importers) {
		for (const request of requests) {
			if (request.star) {
				markAll(file);
				continue;
			}
			for (const name of request.names) mark(file, name);
		}
	}

	const unusedByFile = new Map<string, Set<string>>();
	for (const [file, record] of parsed) {
		const unused = new Set<string>();
		const usedNames = used.get(file) ?? new Set();
		for (const name of record.local) {
			if (!usedNames.has(name) && !record.alwaysExported.has(name)) unused.add(name);
		}
		for (const reexport of record.namedReexports) {
			if (!usedNames.has(reexport.exported)) unused.add(reexport.exported);
		}
		if (record.starReexports.length > 0 && usedNames.size === 0 && !packages.entries.has(file)) {
			unused.add("*");
		}
		if (unused.size > 0) unusedByFile.set(file, unused);
	}
	return { unusedByFile };
}

function collectModule(
	module: EcmaScriptModule,
	program: Program,
	file: string,
	fileSet: ReadonlySet<string>,
	packages: PackageMap,
	record: FileExports,
	importers: Map<string, Array<{ names: string[]; star: boolean }>>,
): void {
	const addImport = (specifier: string, names: string[], star: boolean) => {
		const resolved = resolveSpecifier(file, specifier, fileSet, packages);
		if (resolved === undefined) return;
		const list = importers.get(resolved) ?? [];
		list.push({ names, star });
		importers.set(resolved, list);
	};

	for (const declaration of module.staticImports) {
		const importsNamespace = declaration.entries.some(
			(entry) => entry.importName.kind === "NamespaceObject",
		);
		const names = declaration.entries.flatMap((entry) => {
			if (entry.importName.kind === "Default") return ["default"];
			if (entry.importName.kind === "Name" && entry.importName.name !== null) {
				return [entry.importName.name];
			}
			return [];
		});
		if (importsNamespace) {
			addImport(declaration.moduleRequest.value, [], true);
			continue;
		}
		if (names.length > 0) addImport(declaration.moduleRequest.value, names, false);
	}

	for (const declaration of module.staticExports) {
		for (const entry of declaration.entries) {
			const exported =
				entry.exportName.kind === "Default"
					? "default"
					: entry.exportName.kind === "Name"
						? entry.exportName.name
						: undefined;
			const specifier = entry.moduleRequest?.value;
			if (specifier === undefined) {
				if (exported !== null && exported !== undefined) record.local.add(exported);
				continue;
			}

			const resolved = resolveSpecifier(file, specifier, fileSet, packages);
			if (entry.importName.kind === "AllButDefault") {
				if (resolved !== undefined) record.starReexports.push(resolved);
				continue;
			}
			if (entry.importName.kind === "All") {
				if (exported === null || exported === undefined) continue;
				record.local.add(exported);
				if (resolved !== undefined) {
					record.namespaceReexports.push({ exported, from: resolved });
				}
				continue;
			}
			if (exported === null || exported === undefined) continue;
			if (resolved === undefined || entry.importName.name === null) {
				record.local.add(exported);
				continue;
			}
			record.namedReexports.push({ exported, local: entry.importName.name, from: resolved });
		}
	}

	collectTaggedErrorExports(program, record.alwaysExported);
}

function collectTaggedErrorExports(program: Program, alwaysExported: Set<string>): void {
	for (const statement of program.body) {
		if (
			statement.type === "ExportDefaultDeclaration" &&
			statement.declaration.type === "ClassDeclaration" &&
			isTaggedErrorClass(statement.declaration)
		) {
			alwaysExported.add("default");
			continue;
		}
		if (
			statement.type !== "ExportNamedDeclaration" ||
			statement.declaration?.type !== "ClassDeclaration" ||
			statement.declaration.id === null ||
			!isTaggedErrorClass(statement.declaration)
		) {
			continue;
		}
		alwaysExported.add(statement.declaration.id.name);
	}
}

function isTaggedErrorClass(node: Class): boolean {
	const superclass = node.superClass;
	if (superclass?.type !== "CallExpression") return false;
	const callee = superclass.callee;
	return (
		callee.type === "MemberExpression" &&
		!callee.computed &&
		callee.object.type === "Identifier" &&
		callee.object.name === "errore" &&
		callee.property.type === "Identifier" &&
		callee.property.name === "createTaggedError"
	);
}

function publicModules(root: string): PackageMap {
	const entries = new Set<string>();
	const specifiers = new Map<string, string>();
	for (const directory of workspacePackageDirectories(root)) {
		const packageJsonPath = join(directory, "package.json");
		if (!existsSync(packageJsonPath)) continue;
		const raw = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
			name?: unknown;
			main?: unknown;
			bin?: unknown;
			exports?: unknown;
		};
		const name = typeof raw.name === "string" ? raw.name : undefined;
		addEntryCandidate(directory, raw.main, entries);
		if (name !== undefined) addSpecifier(name, raw.main, directory, specifiers);
		addBinEntries(directory, raw.bin, entries);
		addExportEntries(directory, raw.exports, name, entries, specifiers);
	}
	return { entries, specifiers };
}

function addBinEntries(directory: string, bin: unknown, entries: Set<string>): void {
	if (typeof bin === "string") {
		addEntryCandidate(directory, bin, entries);
		return;
	}
	if (bin === undefined || bin === null || typeof bin !== "object" || Array.isArray(bin)) return;
	for (const value of Object.values(bin)) addEntryCandidate(directory, value, entries);
}

function addExportEntries(
	directory: string,
	exportsField: unknown,
	packageName: string | undefined,
	entries: Set<string>,
	specifiers: Map<string, string>,
): void {
	if (typeof exportsField === "string") {
		addEntryCandidate(directory, exportsField, entries);
		if (packageName !== undefined) addSpecifier(packageName, exportsField, directory, specifiers);
		return;
	}
	if (
		exportsField === undefined ||
		exportsField === null ||
		typeof exportsField !== "object" ||
		Array.isArray(exportsField)
	) {
		return;
	}
	for (const [subpath, value] of Object.entries(exportsField)) {
		const specifier =
			packageName === undefined
				? undefined
				: subpath === "."
					? packageName
					: `${packageName}/${subpath.replace(/^\.\//, "")}`;
		if (typeof value === "string") {
			addEntryCandidate(directory, value, entries);
			if (specifier !== undefined) addSpecifier(specifier, value, directory, specifiers);
			continue;
		}
		if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) {
			continue;
		}
		const target = "import" in value ? value.import : "default" in value ? value.default : undefined;
		if (typeof target === "string") {
			addEntryCandidate(directory, target, entries);
			if (specifier !== undefined) addSpecifier(specifier, target, directory, specifiers);
		}
	}
}

function addEntryCandidate(directory: string, value: unknown, entries: Set<string>): void {
	const file = resolveEntryFile(directory, value);
	if (file !== undefined) entries.add(file);
}

function addSpecifier(
	specifier: string,
	value: unknown,
	directory: string,
	specifiers: Map<string, string>,
): void {
	const file = resolveEntryFile(directory, value);
	if (file !== undefined) specifiers.set(specifier, file);
}

function resolveEntryFile(directory: string, value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const absolute = resolve(directory, value);
	for (const candidate of sourceCandidates(absolute)) {
		if (existsSync(candidate) && sourceExtensions.has(extname(candidate))) {
			return normalize(candidate);
		}
	}
	return mapDistToSrc(directory, absolute);
}

function mapDistToSrc(directory: string, absolute: string): string | undefined {
	const fromPackage = relative(directory, absolute);
	if (!fromPackage.startsWith(`dist${sep}`)) return undefined;
	const rest = fromPackage.slice(`dist${sep}`.length).replace(/\.js$/, "");
	for (const candidate of [`src/${rest}.ts`, `src/${rest}.tsx`]) {
		const path = join(directory, candidate);
		if (existsSync(path)) return normalize(path);
	}
	return undefined;
}

function resolveSpecifier(
	fromFile: string,
	specifier: string,
	fileSet: ReadonlySet<string>,
	packages: PackageMap,
): string | undefined {
	if (specifier.startsWith(".")) {
		const base = resolve(dirname(fromFile), specifier);
		for (const candidate of sourceCandidates(base)) {
			if (fileSet.has(candidate)) return candidate;
		}
		return undefined;
	}
	return packages.specifiers.get(specifier);
}

function sourceCandidates(base: string): string[] {
	const withoutJs = base.replace(/\.jsx?$/, "");
	return [
		normalize(base),
		normalize(`${withoutJs}.ts`),
		normalize(`${withoutJs}.tsx`),
		normalize(join(withoutJs, "index.ts")),
		normalize(join(withoutJs, "index.tsx")),
	];
}

function listSourceFiles(root: string): string[] {
	const files: string[] = [];
	const visit = (directory: string) => {
		for (const entry of readdirSync(directory)) {
			if (skipDirectoryNames.has(entry)) continue;
			const path = join(directory, entry);
			const stats = statSync(path);
			if (stats.isDirectory()) {
				visit(path);
				continue;
			}
			if (!sourceExtensions.has(extname(entry))) continue;
			if (entry.endsWith(".d.ts")) continue;
			files.push(normalize(path));
		}
	};
	for (const top of ["apps", "infra", "packages"]) {
		const path = join(root, top);
		if (existsSync(path)) visit(path);
	}
	return files;
}

function workspacePackageDirectories(root: string): string[] {
	const directories: string[] = [];
	for (const top of ["apps", "infra", "packages"]) {
		const path = join(root, top);
		if (!existsSync(path)) continue;
		if (existsSync(join(path, "package.json"))) {
			directories.push(path);
			continue;
		}
		for (const entry of readdirSync(path)) {
			const child = join(path, entry);
			if (existsSync(join(child, "package.json"))) directories.push(child);
		}
	}
	return directories;
}

function isToolingEntryFile(path: string): boolean {
	const filename = path.split(sep).at(-1);
	if (filename === undefined) return false;
	return (
		filename.endsWith(".config.ts") ||
		filename.endsWith(".config.mts") ||
		filename === "forge.config.ts" ||
		filename === "alchemy.run.ts"
	);
}

function normalize(path: string): string {
	return resolve(path);
}
