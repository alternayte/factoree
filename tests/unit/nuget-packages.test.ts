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
  it("reads elements, attributes in any case and text, CDATA as text, and skips comments and the declaration", () => {
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
    expect(descendantsNamed(document, "Description")[0]?.text).toBe("<b>not a tag</b>");
    expect(descendantsNamed(document, "b")).toEqual([]);
  });

  it("decodes entities in attributes", () => {
    const document = parseXml(`<a value="https://x/?a=1&amp;b=2" />`);
    expect(attributeOf(descendantsNamed(document, "a")[0]!, "value")).toBe("https://x/?a=1&b=2");
  });

  it("keeps a numeric entity past Unicode as written instead of failing", () => {
    const document = parseXml(`<a value="x&#x110000;y&#65;" />`);
    expect(attributeOf(descendantsNamed(document, "a")[0]!, "value")).toBe("x&#x110000;yA");
  });

  it("reads many tags with no closing `>` in linear time", () => {
    const started = performance.now();
    expect(descendantsNamed(parseXml(`${"<a ".repeat(40_000)}<b />`), "b")).toHaveLength(1);
    expect(performance.now() - started).toBeLessThan(1_000);
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

  it("gives no values for an expression with more values than the cap, instead of dropping some", () => {
    const properties = new Map([
      ["major", ["1", "2", "3"]],
      ["minor", ["0", "1", "2"]],
    ]);
    expect(expandMsbuild("$(Major).$(Minor).0", properties)).toBeNull();
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

  it("keeps what a conditional Update or Remove may skip, and keeps each conditional central version", () => {
    const references = readNugetPackageReferences([
      {
        path: "Directory.Packages.props",
        text: `<Project><ItemGroup>
          <PackageVersion Include="Central" Version="1.0.0" Condition="'$(TargetFramework)' == 'net48'" />
          <PackageVersion Include="Central" Version="2.0.0" Condition="'$(TargetFramework)' == 'net8.0'" />
        </ItemGroup></Project>`,
      },
      {
        path: "A.csproj",
        text: `<Project><ItemGroup>
          <PackageReference Include="Central" />
          <PackageReference Include="Updated" Version="1.0.0" />
          <PackageReference Include="Removed" Version="1.0.0" />
        </ItemGroup>
        <ItemGroup Condition="'$(TargetFramework)' == 'net8.0'">
          <PackageReference Update="Updated" Version="2.0.0" />
          <PackageReference Remove="Removed" />
        </ItemGroup></Project>`,
      },
    ]);
    expect(references.map((entry) => `${entry.id} ${entry.version ?? "-"}`)).toEqual(["Central 1.0.0", "Central 2.0.0", "Updated 1.0.0", "Updated 2.0.0", "Removed 1.0.0"]);
  });

  it("expands a property where it is assigned, as MSBuild does", () => {
    const references = readNugetPackageReferences([
      {
        path: "A.csproj",
        text: `<Project><PropertyGroup><Base>1</Base><Saved>$(Base).0.0</Saved><Base>2</Base></PropertyGroup>
          <ItemGroup><PackageReference Include="Lib" Version="$(Saved)" /></ItemGroup></Project>`,
      },
    ]);
    expect(references.map((entry) => entry.version)).toEqual(["1.0.0"]);
  });

  it("leaves a property that a later assignment defines unexpanded, so the version stays unchecked", () => {
    const references = readNugetPackageReferences([
      {
        path: "A.csproj",
        text: `<Project><PropertyGroup><Saved>$(Base).0.0</Saved><Base>1</Base></PropertyGroup>
          <ItemGroup><PackageReference Include="Lib" Version="$(Saved)" /></ItemGroup></Project>`,
      },
    ]);
    expect(references).toHaveLength(1);
    expect(references[0]).toMatchObject({ version: null, unchecked: expect.stringContaining("$(Base)") as string });
  });

  it("marks a version with more values than the cap unchecked", () => {
    const references = readNugetPackageReferences([
      {
        path: "A.csproj",
        text: `<Project>${["1", "2", "3"].map((value) => `<PropertyGroup Condition="'$(X)' == '${value}'"><Major>${value}</Major><Minor>${value}</Minor></PropertyGroup>`).join("")}
          <ItemGroup><PackageReference Include="Lib" Version="$(Major).$(Minor).0" /></ItemGroup></Project>`,
      },
    ]);
    expect(references).toHaveLength(1);
    expect(references[0]).toMatchObject({ version: null, unchecked: expect.stringContaining("more than 8 values") as string });
  });

  it("takes the nearest Directory.Build.props, and a parent one only when it imports it", () => {
    const root = { path: "Directory.Build.props", text: '<Project><ItemGroup><PackageReference Include="Root.Only" Version="1.0.0" /></ItemGroup></Project>' };
    const project = { path: "src/A/A.csproj", text: '<Project><ItemGroup><PackageReference Include="Own" Version="1.0.0" /></ItemGroup></Project>' };
    const nested = (text: string) => ({ path: "src/Directory.Build.props", text });
    const idsOf = (files: Array<{ path: string; text: string }>) => readNugetPackageReferences(files).map((entry) => entry.id);
    expect(idsOf([root, nested("<Project />"), project])).toEqual(["Own"]);
    expect(idsOf([root, nested(`<Project><Import Project="$([MSBuild]::GetPathOfFileAbove('Directory.Build.props', '$(MSBuildThisFileDirectory)../'))" /></Project>`), project])).toEqual(["Root.Only", "Own"]);
    expect(idsOf([root, project])).toEqual(["Root.Only", "Own"]);
  });

  it("resolves an explicit import path from the importing file, skipping the props in between", () => {
    const root = { path: "Directory.Build.props", text: '<Project><ItemGroup><PackageReference Include="Root.Only" Version="1.0.0" /></ItemGroup></Project>' };
    const middle = { path: "src/Directory.Build.props", text: '<Project><ItemGroup><PackageReference Include="Middle.Only" Version="1.0.0" /></ItemGroup></Project>' };
    const nearest = { path: "src/A/Directory.Build.props", text: '<Project><Import Project="..\\..\\Directory.Build.props" /></Project>' };
    const project = { path: "src/A/A.csproj", text: '<Project><ItemGroup><PackageReference Include="Own" Version="1.0.0" /></ItemGroup></Project>' };
    expect(readNugetPackageReferences([root, middle, nearest, project]).map((entry) => entry.id)).toEqual(["Root.Only", "Own"]);
  });

  it("applies a parent props where its import stands, so only what follows the import overrides it", () => {
    const root = { path: "Directory.Build.props", text: "<Project><PropertyGroup><Before>1</Before><After>1</After></PropertyGroup></Project>" };
    const nearest = {
      path: "src/Directory.Build.props",
      text: `<Project><PropertyGroup><Before>2</Before></PropertyGroup>
        <Import Project="..\\Directory.Build.props" />
        <PropertyGroup><After>2</After></PropertyGroup></Project>`,
    };
    const project = { path: "src/A/A.csproj", text: '<Project><ItemGroup><PackageReference Include="Lib" Version="$(Before).$(After).0" /></ItemGroup></Project>' };
    expect(readNugetPackageReferences([root, nearest, project]).map((entry) => entry.version)).toEqual(["1.2.0"]);
  });

  it("applies each parent import in document order, so the last one wins", () => {
    const root = { path: "Directory.Build.props", text: "<Project><PropertyGroup><V>1</V></PropertyGroup></Project>" };
    const middle = { path: "src/Directory.Build.props", text: "<Project><PropertyGroup><V>2</V></PropertyGroup></Project>" };
    const nearest = {
      path: "src/A/Directory.Build.props",
      text: '<Project><Import Project="..\\..\\Directory.Build.props" /><Import Project="..\\Directory.Build.props" /></Project>',
    };
    const project = { path: "src/A/A.csproj", text: '<Project><ItemGroup><PackageReference Include="Lib" Version="$(V).0.0" /></ItemGroup></Project>' };
    expect(readNugetPackageReferences([root, middle, nearest, project]).map((entry) => entry.version)).toEqual(["2.0.0"]);
  });

  it("takes a GlobalPackageReference only from the Directory.Packages.props a project imports", () => {
    const references = readNugetPackageReferences([
      { path: "Directory.Packages.props", text: '<Project><ItemGroup><GlobalPackageReference Include="Root.Analyzers" Version="1.0.0" /></ItemGroup></Project>' },
      { path: "src/Directory.Packages.props", text: '<Project><ItemGroup><GlobalPackageReference Include="Src.Analyzers" Version="1.0.0" /></ItemGroup></Project>' },
      { path: "src/A/A.csproj", text: "<Project />" },
      { path: "src/B/B.csproj", text: "<Project />" },
    ]);
    expect(references.map((entry) => `${entry.id} ${entry.project}`)).toEqual(["Src.Analyzers src/Directory.Packages.props"]);
  });

  it("reads a version written as CDATA", () => {
    const references = readNugetPackageReferences([{ path: "A.csproj", text: '<Project><ItemGroup><PackageReference Include="Lib"><Version><![CDATA[1.2.3]]></Version></PackageReference></ItemGroup></Project>' }]);
    expect(references.map((entry) => entry.version)).toEqual(["1.2.3"]);
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
