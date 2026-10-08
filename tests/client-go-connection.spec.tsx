/** @vitest-environment jsdom */
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { OpenCodeGoConnectionView, type GoSnapshot, type GoViewProps } from "../src/client/components/OpenCodeGoConnectionView.tsx";
afterEach(cleanup);
function snapshot(revision=2): GoSnapshot {
	return {credential:{selectedRef:"EXISTING_GO_KEY",configured:true,writable:false,requiresChoice:false,candidates:[{ref:"EXISTING_GO_KEY",configured:true,writable:false},{ref:"OPENCODE_GO_API_KEY",configured:false,writable:true}]},configuration:{revision,writable:true,ready:true,conflicts:[],models:[{id:"deepseek-v4.1-flash"}]},call:{active:true,lastCall:"no-call",updatedAt:null}};
}
function props(): GoViewProps {
	const status=snapshot();
	return {status,t:key=>key,onReload:vi.fn(async()=>status),onSaveCredential:vi.fn(async()=>status),onClearCredential:vi.fn(async()=>status),onLoadModels:vi.fn(async()=>({models:[{id:"deepseek-v4.1-flash"},{id:"deepseek-v4-flash",reasoningEfforts:{high:"high"}},{id:"gpt-5.6-luna"}]})),onApply:vi.fn(async()=>status),onStartConversation:vi.fn()};
}
it("shows a compact connected summary and adopts the resolved credential without a picker", async()=>{
	const input=props();render(createElement(OpenCodeGoConnectionView,input));
	expect(screen.queryByLabelText("apiKey")).toBeNull();
	fireEvent.click(screen.getByRole("button",{name:"edit"}));
	// The reference picker is gone: the slot is shown as a hint instead.
	expect(screen.queryByLabelText("credential")).toBeNull();
	// The resolved slot is read-only here, so both credential buttons are off and
	// the input cannot be typed into...
	expect((screen.getByLabelText("apiKey") as HTMLInputElement).disabled).toBe(true);
	expect((screen.getByRole("button",{name:"saveKey"}) as HTMLButtonElement).disabled).toBe(true);
	expect((screen.getByRole("button",{name:"clearKey"}) as HTMLButtonElement).disabled).toBe(true);
	// ...but the directory can still be read, because the slot IS configured.
	expect((screen.getByRole("button",{name:"fetchModels"}) as HTMLButtonElement).disabled).toBe(false);
});
it("enables save and fetch when the in-use slot is writable and configured", async()=>{
	const base=snapshot();
	// A configured, writable store slot: the ordinary "already set up" case.
	const stored={...base,credential:{...base.credential,selectedRef:"OPENCODE_GO_API_KEY",configured:true,candidates:[{ref:"OPENCODE_GO_API_KEY",configured:true,writable:true}]}};
	const input=props();
	render(createElement(OpenCodeGoConnectionView,{...input,status:stored}));
	fireEvent.click(screen.getByRole("button",{name:"edit"}));
	expect((screen.getByLabelText("apiKey") as HTMLInputElement).disabled).toBe(false);
	expect((screen.getByRole("button",{name:"saveKey"}) as HTMLButtonElement).disabled).toBe(true);
	expect((screen.getByRole("button",{name:"clearKey"}) as HTMLButtonElement).disabled).toBe(false);
	fireEvent.change(screen.getByLabelText("apiKey"),{target:{value:"fixture-key"}});
	fireEvent.click(screen.getByRole("button",{name:"saveKey"}));
	await waitFor(()=>expect(input.onSaveCredential).toHaveBeenCalledWith({credentialRef:"OPENCODE_GO_API_KEY",apiKey:"fixture-key"}));
});
it("clears the stored key after confirmation", async()=>{
	const base=snapshot();
	const stored={...base,credential:{...base.credential,selectedRef:"OPENCODE_GO_API_KEY",configured:true,candidates:[{ref:"OPENCODE_GO_API_KEY",configured:true,writable:true}]}};
	const input=props();
	const confirmSpy=vi.spyOn(globalThis,"confirm").mockReturnValue(true);
	render(createElement(OpenCodeGoConnectionView,{...input,status:stored}));
	fireEvent.click(screen.getByRole("button",{name:"edit"}));
	fireEvent.click(screen.getByRole("button",{name:"clearKey"}));
	await waitFor(()=>expect(input.onClearCredential).toHaveBeenCalledWith({credentialRef:"OPENCODE_GO_API_KEY"}));
	confirmSpy.mockRestore();
});
it("does not clear the stored key when the confirmation is declined", async()=>{
	const base=snapshot();
	const stored={...base,credential:{...base.credential,selectedRef:"OPENCODE_GO_API_KEY",configured:true,candidates:[{ref:"OPENCODE_GO_API_KEY",configured:true,writable:true}]}};
	const input=props();
	const confirmSpy=vi.spyOn(globalThis,"confirm").mockReturnValue(false);
	render(createElement(OpenCodeGoConnectionView,{...input,status:stored}));
	fireEvent.click(screen.getByRole("button",{name:"edit"}));
	fireEvent.click(screen.getByRole("button",{name:"clearKey"}));
	expect(confirmSpy).toHaveBeenCalled();
	expect(input.onClearCredential).not.toHaveBeenCalled();
	confirmSpy.mockRestore();
});
it("uses a fresh query revision for new edits and applies the enabled model set", async()=>{
	const input=props();const view=render(createElement(OpenCodeGoConnectionView,input));
	view.rerender(createElement(OpenCodeGoConnectionView,{...input,status:snapshot(9)}));
	fireEvent.click(screen.getByRole("button",{name:"edit"}));
	fireEvent.click(screen.getByRole("button",{name:"fetchModels"}));
	await waitFor(()=>expect(input.onLoadModels).toHaveBeenCalled());
	const flash=await screen.findByRole("checkbox",{name:/deepseek-v4-flash/i});
	fireEvent.click(flash);
	view.rerender(createElement(OpenCodeGoConnectionView,{...input,status:snapshot(10)}));
	fireEvent.click(screen.getByRole("button",{name:"apply"}));
	await waitFor(()=>expect(input.onApply).toHaveBeenCalledWith(expect.objectContaining({expectedRevision:9,credentialRef:"EXISTING_GO_KEY",models:expect.arrayContaining([{id:"deepseek-v4.1-flash"},expect.objectContaining({id:"deepseek-v4-flash"})])})));
});
it("retains failed credential input and renders a later cancelled call instead of stale success",async()=>{
	const base=snapshot();
	// A writable, unconfigured slot so the input accepts the typed value.
	const target={...base,credential:{...base.credential,selectedRef:"OPENCODE_GO_API_KEY",configured:false,candidates:[{ref:"OPENCODE_GO_API_KEY",configured:false,writable:true}]}};
	const input={...props(),onSaveCredential:vi.fn(async()=>{throw new Error("storage blocked");})};
	const view=render(createElement(OpenCodeGoConnectionView,{...input,status:{...target,configuration:{...target.configuration,ready:false}}}));
	fireEvent.change(screen.getByLabelText("apiKey"),{target:{value:"fixture-only"}});
	fireEvent.click(screen.getByRole("button",{name:"saveKey"}));
	await screen.findByText("storage blocked");
	// The typed key survives a failed save so the operator does not retype it.
	expect((screen.getByLabelText("apiKey") as HTMLInputElement).value).toBe("fixture-only");
	view.rerender(createElement(OpenCodeGoConnectionView,{...input,call:{active:true,lastCall:"failure",streamStatus:"cancelled",updatedAt:10}}));
	expect(screen.getByText("status.cancelled")).toBeTruthy();
});
it("keeps the model list inside the card instead of a floating datalist", async()=>{
	const input=props();
	render(createElement(OpenCodeGoConnectionView,{...input,status:{...snapshot(),configuration:{...snapshot().configuration,ready:false}}}));
	fireEvent.click(screen.getByRole("button",{name:"fetchModels"}));
	await screen.findByRole("group",{name:"model"});
	expect(document.querySelector("datalist")).toBeNull();
});
