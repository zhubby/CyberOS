import type { ShareProtocol } from "@cyberos/shared";
import { Switch } from "../common/Switch.js";
import { DLNA_MEDIA_TYPES, toggleDlnaMediaType, type ShareDefinitionFormState, type ShareProtocolFormState } from "../../config/share-settings.js";
type Translate = (key: string) => string;
export function ShareProtocolFields({ protocol, share, update, t }: {
  protocol: ShareProtocol; share: ShareDefinitionFormState;
  update: <P extends ShareProtocol>(protocol: P, patch: Partial<ShareProtocolFormState[P]>) => void;
  t: Translate;
}) {
  return <>
  {protocol === "smb" ? <div className="share-protocol-fields">
    <SwitchField
      label={t("workspace.management.shares.fields.readOnly")}
      checked={share.protocols.smb.readOnly}
      onChange={(readOnly) => update("smb", { readOnly })}
    />
    <SwitchField
      label={t("workspace.management.shares.fields.browseable")}
      checked={share.protocols.smb.browseable}
      onChange={(browseable) => update("smb", { browseable })}
    />
    <SwitchField
      label={t("workspace.management.shares.fields.allowGuest")}
      checked={share.protocols.smb.allowGuest}
      onChange={(allowGuest) => update("smb", { allowGuest })}
    />
  </div> : null}

  {protocol === "webdav" ? <div className="share-protocol-fields">
    <TextField
      label={t("workspace.management.shares.fields.port")}
      value={share.protocols.webdav.port}
      inputMode="numeric"
      onChange={(port) => update("webdav", { port })}
    />
    <TextField
      label={t("workspace.management.shares.fields.pathPrefix")}
      value={share.protocols.webdav.pathPrefix}
      onChange={(pathPrefix) => update("webdav", { pathPrefix })}
    />
    <SwitchField
      label={t("workspace.management.shares.fields.readOnly")}
      checked={share.protocols.webdav.readOnly}
      onChange={(readOnly) => update("webdav", { readOnly })}
    />
    <SwitchField
      label={t("workspace.management.shares.fields.allowGuest")}
      checked={share.protocols.webdav.allowGuest}
      onChange={(allowGuest) => update("webdav", { allowGuest })}
    />
  </div> : null}

  {protocol === "ftp" ? <div className="share-protocol-fields">
    <TextField
      label={t("workspace.management.shares.fields.port")}
      value={share.protocols.ftp.port}
      inputMode="numeric"
      onChange={(port) => update("ftp", { port })}
    />
    <TextField
      label={t("workspace.management.shares.fields.passiveStart")}
      value={share.protocols.ftp.passivePortStart}
      inputMode="numeric"
      onChange={(passivePortStart) => update("ftp", { passivePortStart })}
    />
    <TextField
      label={t("workspace.management.shares.fields.passiveEnd")}
      value={share.protocols.ftp.passivePortEnd}
      inputMode="numeric"
      onChange={(passivePortEnd) => update("ftp", { passivePortEnd })}
    />
    <SwitchField
      label={t("workspace.management.shares.fields.readOnly")}
      checked={share.protocols.ftp.readOnly}
      onChange={(readOnly) => update("ftp", { readOnly })}
    />
    <SwitchField
      label={t("workspace.management.shares.fields.allowGuest")}
      checked={share.protocols.ftp.allowGuest}
      onChange={(allowGuest) => update("ftp", { allowGuest })}
    />
  </div> : null}

  {protocol === "nfs" ? <div className="share-protocol-fields">
    <label className="share-field-wide">
      <span>{t("workspace.management.shares.fields.allowedCidrs")}</span>
      <textarea
        value={share.protocols.nfs.allowedCidrs}
        onChange={(event) => update("nfs", { allowedCidrs: event.target.value })}
        placeholder="192.168.1.0/24"
      />
    </label>
    <SwitchField
      label={t("workspace.management.shares.fields.readOnly")}
      checked={share.protocols.nfs.readOnly}
      onChange={(readOnly) => update("nfs", { readOnly })}
    />
    <SwitchField
      label={t("workspace.management.shares.fields.rootSquash")}
      checked={share.protocols.nfs.rootSquash}
      onChange={(rootSquash) => update("nfs", { rootSquash })}
    />
  </div> : null}

  {protocol === "dlna" ? <div className="share-protocol-fields">
    <TextField
      label={t("workspace.management.shares.fields.friendlyName")}
      value={share.protocols.dlna.friendlyName}
      onChange={(friendlyName) => update("dlna", { friendlyName })}
    />
    <TextField
      label={t("workspace.management.shares.fields.bindInterface")}
      value={share.protocols.dlna.bindInterface}
      onChange={(bindInterface) => update("dlna", { bindInterface })}
      placeholder="eth0"
    />
    <TextField
      label={t("workspace.management.shares.fields.bindAddress")}
      value={share.protocols.dlna.bindAddress}
      onChange={(bindAddress) => update("dlna", { bindAddress })}
      placeholder="192.168.1.10"
    />
    <div className="share-media-type-group">
      <span>{t("workspace.management.shares.fields.mediaTypes")}</span>
      <div>
        {DLNA_MEDIA_TYPES.map((mediaType) => (
          <CheckField
            key={mediaType}
            label={t(`workspace.management.shares.mediaTypes.${mediaType}`)}
            checked={share.protocols.dlna.mediaTypes.includes(mediaType)}
            onChange={() =>
              update("dlna", {
                mediaTypes: toggleDlnaMediaType(share.protocols.dlna.mediaTypes, mediaType)
              })
            }
          />
        ))}
      </div>
    </div>
  </div> : null}</>;
}
function TextField({
  label,
  value,
  placeholder,
  inputMode,
  onChange
}: {
  label: string;
  value: string;
  placeholder?: string;
  inputMode?: "numeric" | "text";
  onChange: (value: string) => void;
}) {
  return (
    <label>
      <span>{label}</span>
      <input value={value} placeholder={placeholder} inputMode={inputMode} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function CheckField({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return <label className="share-media-checkbox"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /><span>{label}</span></label>;
}

function SwitchField({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return <Switch checked={checked} label={label} onCheckedChange={onChange} />;
}
