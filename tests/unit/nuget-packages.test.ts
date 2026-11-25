import { describe, expect, it } from "vitest";
import {
  compareNugetVersions,
  expandMsbuild,
  isNugetPackageFile,
  lookupsOf,
  normalizeNugetVersion,
  nugetVersionsEqual,
  readNugetPackageReferences,
  readVersionText,
} from "~/domain/setup/nuget-packages.js";
import { attributeOf, childrenNamed, descendantsNamed, parseXml } from "~/domain/setup/xml-elements.js";

describe("parseXml", () => {
  it("reads elements, attributes in any case and text, and skips comments, CDATA and the declaration", () => {
    const document = parseXml(`<?xml version="1.0"?>
<!-- <PackageReference Include="Commented" Version="1.0.0" /> -->
<Project>
  <ItemGroup Condition="'$(TargetFramework)' == 'net8.0'">
    <PackageReference INCLUDE='A.B' Version="1.2.3"/>
    <PackageReference Include="C"><Version>2.0.0</Version></PackageReference>
    <Description><![CDATA[<b>not a tag</b>]]></Description>
  </ItemGroup>
</Project>`);
    const references = descendantsNamed(document, "packagereference");
    expect(references.map((element) => attributeOf(element, "include"))).toEqual(["A.B", "C"]);
    expect(childrenNamed(references[1]!, "version")[0]?.text).toBe("2.0.0");
    expect(attributeOf(descendantsNamed(document, "ItemGroup")[0]!, "Condition")).toBe("'$(TargetFramework)' == 'net8.0'");
  });

  it("decodes entities in attributes", () => {
    const document = parseXml(`<a value="https://x/?a=1&amp;b=2" />`);
    expect(attributeOf(descendantsNamed(document, "a")[0]!, "value")).toBe("https://x/?a=1&b=2");
  });
});

describe("NuGet versions", () => {
  it("normalises as NuGet does", () => {
    expect(normalizeNugetVersion("0.2.6.0")).toBe("0.2.6");
    expect(normalizeNugetVersion("1.0")).toBe("1.0.0");
    expect(normalizeNugetVersion("1.2.3.4")).toBe("1.2.3.4");
    expect(normalizeNugetVersion("01.002.3")).toBe("1.2.3");
    expect(normalizeNugetVersion("1.0.0-Beta.1+build.5")).toBe("1.0.0-beta.1");
    expect(normalizeNugetVersion("latest")).toBeNull();
    expect(nugetVersionsEqual("0.2.6", "0.2.6.0")).toBe(true);
    expect(nugetVersionsEqual("1.0.0-Beta", "1.0.0-beta")).toBe(true);
  });

  it("orders a prerelease before its release, and numeric labels by number", () => {
    expect(compareNugetVersions("1.0.0-beta", "1.0.0")).toBe(-1);
    expect(compareNugetVersions("1.0.0-beta.10", "1.0.0-beta.2")).toBe(1);
    expect(compareNugetVersions("1.10.0", "1.9.0")).toBe(1);
    expect(compareNugetVersions("2.0", "2.0.0.0")).toBe(0);
    expect(compareNugetVersions("1.0.0-RC", "1.0.0-rc")).toBe(0);
    expect(compareNugetVersions("1.0.0-alpha", "1.0.0-Beta")).toBe(-1);
    expect(compareNugetVersions("x", "1.0.0")).toBeNull();
  });

  it("checks an exact version and leaves a floating version, a range or a property unchecked", () => {
    expect(readVersionText("1.2.3")).toEqual({ kind: "exact", version: "1.2.3" });
    expect(readVersionText("[1.2.3]")).toEqual({ kind: "exact", version: "1.2.3" });
    expect(readVersionText("1.*")).toMatchObject({ kind: "unchecked", reason: expect.stringContaining("floating") as string });
    expect(readVersionText("[1.0,2.0)")).toMatchObject({ kind: "unchecked", reason: expect.stringContaining("range") as string });
    expect(readVersionText("$(CoreVersion)")).toMatchObject({ kind: "unchecked", reason: expect.stringContaining("$(CoreVersion)") as string });
    expect(readVersionText("")).toEqual({ kind: "unchecked", reason: "no version" });
  });

  it("expands every value a conditional property can take", () => {
    const properties = new Map([["core", ["1.0.0", "2.0.0"]]]);
    expect(expandMsbuild("$(Core)", properties)).toEqual(["1.0.0", "2.0.0"]);
    expect(expandMsbuild("$(Missing)", properties)).toEqual(["$(Missing)"]);
  });
});

describe("readNugetPackageReferences", () => {
  it("takes Version as an attribute or an element and a property from Directory.Build.props", () => {
    const references = readNugetPackageReferences([
      { path: "Directory.Build.props", text: "<Project><PropertyGroup><HangfireVersion>1.8.6</HangfireVersion></PropertyGroup></Project>" },
      {
        path: "src/Api/Api.csproj",
        text: `<Project><ItemGroup>
          <PackageReference Include="Hangfire.Pro" Version="$(HangfireVersion)" />
          <PackageReference Include="Frontiers.Auth"><Version>0.2.6.0</Version></PackageReference>
        </ItemGroup></Project>`,
      },
    ]);
    expect(references.map((entry) => [entry.id, entry.version, entry.project])).toEqual([
      ["Hangfire.Pro", "1.8.6", "src/Api/Api.csproj"],
      ["Frontiers.Auth", "0.2.6", "src/Api/Api.csproj"],
    ]);
  });

  it("gives central package management its PackageVersion, lets VersionOverride win, and attributes a GlobalPackageReference to its props", () => {
    const references = readNugetPackageReferences([
      {
        path: "Directory.Packages.props",
        text: `<Project><ItemGroup>
          <PackageVersion Include="Frontiers.Core" Version="3.1.0" />
          <PackageVersion Include="Serilog" Version="3.0.0" />
          <GlobalPackageReference Include="Frontiers.Analyzers" Version="1.0.0" />
        </ItemGroup></Project>`,
      },
      {
        path: "src/A/A.csproj",
        text: `<Project><ItemGroup>
          <PackageReference Include="Frontiers.Core" />
          <PackageReference Include="Serilog" VersionOverride="3.1.1" />
        </ItemGroup></Project>`,
      },
    ]);
    expect(references.map((entry) => `${entry.id} ${entry.version ?? "-"} ${entry.project}`)).toEqual([
      "Frontiers.Analyzers 1.0.0 Directory.Packages.props",
      "Frontiers.Core 3.1.0 src/A/A.csproj",
      "Serilog 3.1.1 src/A/A.csproj",
    ]);
  });

  it("applies Update and Remove in import order", () => {
    const references = readNugetPackageReferences([
      { path: "Directory.Build.props", text: '<Project><ItemGroup><PackageReference Include="Common" Version="1.0.0" /><PackageReference Include="Dropped" Version="1.0.0" /></ItemGroup></Project>' },
      { path: "A.csproj", text: '<Project><ItemGroup><PackageReference Update="Common" Version="2.0.0" /><PackageReference Remove="Dropped" /></ItemGroup></Project>' },
    ]);
    expect(references.map((entry) => `${entry.id} ${entry.version ?? "-"}`)).toEqual(["Common 2.0.0"]);
  });

  it("checks each version a target framework condition gives", () => {
    const references = readNugetPackageReferences([
      {
        path: "A.csproj",
        text: `<Project><ItemGroup Condition="'$(TargetFramework)' == 'net48'"><PackageReference Include="Lib" Version="1.0.0" /></ItemGroup>
          <ItemGroup Condition="'$(TargetFramework)' == 'net8.0'"><PackageReference Include="Lib" Version="2.0.0" /></ItemGroup></Project>`,
      },
    ]);
    expect(references.map((entry) => entry.version)).toEqual(["1.0.0", "2.0.0"]);
    expect(references[0]?.condition).toContain("net48");
  });

  it("reads packages.config and the dotnet tool manifest, and marks an unresolved version unchecked", () => {
    const references = readNugetPackageReferences([
      { path: "legacy/packages.config", text: '<packages><package id="Frontiers.Legacy" version="1.0.0.0" targetFramework="net48" /></packages>' },
      { path: ".config/dotnet-tools.json", text: JSON.stringify({ version: 1, tools: { "frontiers.tool": { version: "2.1.0", commands: ["ft"] } } }) },
      { path: "A.csproj", text: '<Project><ItemGroup><PackageReference Include="Floating" Version="1.*" /><PackageReference Include="Prop" Version="$(Nope)" /></ItemGroup></Project>' },
    ]);
    expect(references.map((entry) => `${entry.id} ${entry.version ?? `unchecked: ${entry.unchecked ?? ""}`}`)).toEqual([
      "Frontiers.Legacy 1.0.0",
      "frontiers.tool 2.1.0",
      "Floating unchecked: the floating version `1.*`",
      "Prop unchecked: the MSBuild property $(Nope) does not resolve",
    ]);
  });

  it("groups lookups by id in any case and version, with every project", () => {
    const lookups = lookupsOf(readNugetPackageReferences([
      { path: "A.csproj", text: '<Project><ItemGroup><PackageReference Include="Lib" Version="1.0.0" /></ItemGroup></Project>' },
      { path: "B.csproj", text: '<Project><ItemGroup><PackageReference Include="lib" Version="1.0.0.0" /><PackageReference Include="Abc" Version="1.0.0" /></ItemGroup></Project>' },
    ]));
    expect(lookups).toEqual([
      { id: "Abc", version: "1.0.0", projects: ["B.csproj"] },
      { id: "Lib", version: "1.0.0", projects: ["A.csproj", "B.csproj"] },
    ]);
  });

  it("takes only the files a package read needs", () => {
    expect(["a/A.csproj", "b.fsproj", "Directory.Packages.props", "directory.build.targets", "x/packages.config", ".config/dotnet-tools.json"].every(isNugetPackageFile)).toBe(true);
    expect(isNugetPackageFile("README.md")).toBe(false);
  });
});
