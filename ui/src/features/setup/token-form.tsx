import { useState } from "react";
import { Button } from "@/components/button";
import { Field, Input } from "@/components/form";
import { Alert } from "@/components/layout";

export function TokenForm({ onSubmit, rejected }: { onSubmit: (token: string) => void; rejected: boolean }) {
  const [value, setValue] = useState("");
  return (
    <form
      className="card enter p-6"
      onSubmit={(event) => {
        event.preventDefault();
        const token = value.trim();
        if (token) onSubmit(token);
      }}
    >
      <p className="t-crumb">setup</p>
      <h1 className="t-title mt-2">Set up Factoree</h1>
      <p className="mt-2 text-sm text-mute">
        On its first start the API writes a one-time setup token to its log. Paste it here. The token stays in this
        browser tab only.
      </p>
      {rejected ? (
        <Alert tone="danger" className="mt-4">
          The API refused that token. Copy the token again from the API log.
        </Alert>
      ) : null}
      <Field label="Setup token" className="mt-5" hint="Search the API log for “setup token”.">
        {(props) => (
          <Input
            {...props}
            mono
            type="password"
            autoComplete="off"
            spellCheck={false}
            required
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        )}
      </Field>
      <Button type="submit" variant="primary" className="mt-5 w-full" disabled={!value.trim()}>
        Continue
      </Button>
    </form>
  );
}
