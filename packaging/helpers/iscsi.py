#!/usr/bin/python3
"""Fixed hostd helper for CyberOS-owned LIO targets. No shell or targetcli input."""

import array
import copy
from datetime import datetime, timezone
import fcntl
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import uuid

GIB = 1024 ** 3
MAX_BYTES = 9007199254740991
POOL_ID = re.compile(r"^[a-z][a-z0-9_-]{0,31}$")
IQN = re.compile(r"^iqn\.[0-9]{4}-(?:0[1-9]|1[0-2])\.[a-z0-9][a-z0-9.-]*(?::[a-z0-9._:-]+)?$")
TARGET_PREFIX = "iqn.2026-10.local.cyberos:"
NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)


class ManagerError(Exception):
    def __init__(self, message, status=400, code="validation"):
        super().__init__(message)
        self.status = status
        self.code = code


def require(condition, message, status=400, code="validation"):
    if not condition:
        raise ManagerError(message, status, code)


def identifier(value):
    try:
        return isinstance(value, str) and str(uuid.UUID(value)) == value
    except (ValueError, AttributeError):
        return False


def valid_name(value):
    return isinstance(value, str) and 1 <= len(value) <= 64 and value == value.strip() and all(ord(c) >= 32 and ord(c) != 127 for c in value)


def exact(value, required, optional=()):
    return isinstance(value, dict) and set(required) <= set(value) and set(value) <= set(required) | set(optional)


def revision(state):
    return hashlib.sha256(json.dumps(state, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def local_addresses():
    try:
        output = subprocess.run(["/usr/sbin/ip", "-j", "address", "show"], check=True, capture_output=True, timeout=5)
        result = []
        for interface in json.loads(output.stdout):
            for item in interface.get("addr_info", []):
                address = ipaddress.ip_address(item["local"])
                if not (address.is_loopback or address.is_unspecified or address.is_multicast or address.is_link_local) and "tentative" not in item.get("flags", []):
                    result.append(str(address))
        return sorted(set(result))
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        return []


class LioBackend:
    def __init__(self, data_root):
        self.data_root = data_root
        self.root = None

    def available(self):
        if self.root is not None:
            return True
        try:
            if not Path("/sys/kernel/config/target").is_dir():
                return False
            import rtslib_fb
            import rtslib_fb.tcm
            rtslib_fb.tcm.lock_file = str(self.data_root.parent / "state" / "hostd" / "iscsi" / "backstore.lock")
            self.lib = rtslib_fb
            self.root = rtslib_fb.RTSRoot()
            return True
        except Exception:
            return False

    def _target(self, target):
        for item in self.root.targets:
            if item.wwn == target["iqn"] and item.fabric_module.name == "iscsi":
                return item
        return None

    def exists(self, target):
        item = self._target(target)
        return item is not None and any(tpg.enable for tpg in item.tpgs)

    def sessions(self, target):
        item = self._target(target)
        if item is None:
            return []
        result = []
        for tpg in item.tpgs:
            for acl in tpg.node_acls:
                session = acl.session
                if session:
                    connections = session.get("connections", [])
                    address = next((entry.get("address") for entry in connections if entry.get("address")), None)
                    result.append({"initiator": acl.node_wwn, "address": address})
        return result

    def remove(self, target):
        require(target["iqn"] == TARGET_PREFIX + target["id"], "Target identity is invalid")
        item = self._target(target)
        if item is not None:
            require(not self.sessions(target), "Disconnect active iSCSI clients first", 409, "conflict")
            item.delete()
        for lun in target["luns"]:
            self.remove_backstore(lun["imageId"])

    def remove_backstore(self, image_id):
        name = "cyberos-" + image_id
        for obj in self.root.storage_objects:
            if obj.name == name and obj.plugin == "fileio":
                require(not list(obj.attached_luns), "Image is still exported", 409, "conflict")
                obj.delete()
                return

    def apply(self, target, images, replace=False):
        if self._target(target) is not None:
            if not replace:
                return
            self.remove(target)
        if not target["enabled"]:
            return
        lib = self.lib
        created = lib.Target(lib.FabricModule("iscsi"), target["iqn"], mode="create")
        try:
            tpg = lib.TPG(created, 1, mode="create")
            tpg.enable = False
            tpg.set_attribute("generate_node_acls", 0)
            tpg.set_attribute("cache_dynamic_acls", 0)
            tpg.set_attribute("demo_mode_write_protect", 1)
            tpg.set_attribute("authentication", int(target["chap"]["enabled"]))
            lib.NetworkPortal(tpg, target["address"], target["port"], mode="create")
            for lun in target["luns"]:
                image = next(item for item in images if item["id"] == lun["imageId"])
                path = self.data_root / image["storagePoolId"] / ".cyberos" / "iscsi" / (image["id"] + ".img")
                self.remove_backstore(image["id"])
                obj = lib.FileIOStorageObject("cyberos-" + image["id"], dev=str(path), size=image["sizeBytes"], wwn=image["id"], write_back=False)
                lib.LUN(tpg, lun["lun"], storage_object=obj)
            for initiator in target["initiators"]:
                acl = lib.NodeACL(tpg, initiator, mode="create")
                if target["chap"]["enabled"]:
                    acl.chap_userid = target["chap"]["username"]
                    acl.chap_password = target["chap"]["password"]
                for lun in target["luns"]:
                    lib.MappedLUN(acl, lun["lun"], tpg_lun=lun["lun"], write_protect=False)
            tpg.enable = True
        except Exception:
            created.delete()
            for lun in target["luns"]:
                self.remove_backstore(lun["imageId"])
            raise


class Manager:
    def __init__(self, data_root, backend=None, mountinfo=Path("/proc/self/mountinfo"), addresses=None,
                 exports=(Path("/proc/fs/nfsd/exports"), Path("/var/lib/nfs/etab"))):
        self.data_root = Path(data_root)
        require(self.data_root.is_absolute() and self.data_root.name == "data", "Invalid CyberOS data root")
        self.state_dir = self.data_root.parent / "state" / "hostd" / "iscsi"
        self.mountinfo = Path(mountinfo)
        self.backend = backend or LioBackend(self.data_root)
        self.addresses = local_addresses() if addresses is None else addresses
        self.exports = exports
        self._secure_state_dir()

    def _secure_state_dir(self):
        current = self.data_root.parent
        require(current.resolve() == current, "CyberOS root must not contain symlinks")
        for component in ("state", "hostd", "iscsi"):
            current = current / component
            try:
                current.mkdir(mode=0o700)
            except FileExistsError:
                pass
            entry = current.lstat()
            require(stat.S_ISDIR(entry.st_mode) and (component == "state" or entry.st_uid == os.geteuid()), "iSCSI state directory is unsafe")
            if component == "iscsi":
                current.chmod(0o700)

    def load_file(self, name):
        try:
            fd = os.open(self.state_dir / name, os.O_RDONLY | NOFOLLOW)
        except FileNotFoundError:
            return None
        with os.fdopen(fd, "r") as stream:
            entry = os.fstat(stream.fileno())
            require(stat.S_ISREG(entry.st_mode) and entry.st_uid == os.geteuid() and entry.st_nlink == 1 and not entry.st_mode & 0o077,
                    "iSCSI state file is unsafe", 503, "unavailable")
            try:
                return json.load(stream)
            except (ValueError, UnicodeError):
                raise ManagerError("iSCSI state is invalid; repair the managed state before continuing", 503, "unavailable") from None

    def load(self):
        state = self.load_file("state.json")
        if state is None:
            state = {"version": 1, "targets": [], "images": []}
        self.validate_state(state)
        return state

    def validate_state(self, state):
        require(exact(state, ("version", "targets", "images")) and state["version"] == 1 and isinstance(state["targets"], list) and isinstance(state["images"], list), "iSCSI state is invalid", 503, "unavailable")
        ids = set()
        for image in state["images"]:
            require(exact(image, ("id", "name", "storagePoolId", "sizeBytes", "attachedTargetId")) and identifier(image["id"]) and image["id"] not in ids and valid_name(image["name"])
                    and isinstance(image["storagePoolId"], str) and POOL_ID.fullmatch(image["storagePoolId"]) and type(image["sizeBytes"]) is int and GIB <= image["sizeBytes"] <= MAX_BYTES and image["sizeBytes"] % GIB == 0
                    and (image["attachedTargetId"] is None or identifier(image["attachedTargetId"])), "iSCSI image registry is invalid", 503, "unavailable")
            ids.add(image["id"])
        target_ids = set()
        attached = set()
        for target in state["targets"]:
            require(exact(target, ("id", "name", "iqn", "address", "port", "initiators", "chap", "enabled", "luns")) and identifier(target["id"]) and target["id"] not in target_ids
                    and target["iqn"] == TARGET_PREFIX + target["id"] and type(target["enabled"]) is bool and isinstance(target["luns"], list), "iSCSI target registry is invalid", 503, "unavailable")
            self.validate_target(target, local=False)
            target_ids.add(target["id"])
            numbers = set()
            for lun in target["luns"]:
                require(exact(lun, ("imageId", "lun")) and lun["imageId"] in ids and lun["imageId"] not in attached and type(lun["lun"]) is int and 0 <= lun["lun"] <= 255 and lun["lun"] not in numbers,
                        "iSCSI LUN registry is invalid", 503, "unavailable")
                image = next(image for image in state["images"] if image["id"] == lun["imageId"])
                require(image["attachedTargetId"] == target["id"], "iSCSI image attachment is invalid", 503, "unavailable")
                attached.add(lun["imageId"])
                numbers.add(lun["lun"])
        require(all(image["attachedTargetId"] is None or image["id"] in attached for image in state["images"]), "iSCSI image attachment is invalid", 503, "unavailable")

    def write(self, name, value):
        temporary = self.state_dir / ("." + name + "." + str(uuid.uuid4()))
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW, 0o600)
        try:
            with os.fdopen(fd, "w") as stream:
                os.fchmod(stream.fileno(), 0o600)
                json.dump(value, stream, sort_keys=True)
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.state_dir / name)
            self.sync_directory(self.state_dir)
        finally:
            temporary.unlink(missing_ok=True)

    @staticmethod
    def sync_directory(path):
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    def mounts(self):
        try:
            result = {}
            for line in self.mountinfo.read_text().splitlines():
                fields = line.split()
                if "-" not in fields or len(fields) < 7:
                    continue
                path = re.sub(r"\\([0-7]{3})", lambda match: chr(int(match[1], 8)), fields[4])
                result[path] = {"id": fields[0], "device": fields[2], "filesystem": fields[fields.index("-") + 1]}
            return result
        except OSError:
            return {}

    def pool_info(self, pool_id):
        require(isinstance(pool_id, str) and POOL_ID.fullmatch(pool_id), "Invalid storage pool ID")
        path = self.data_root / pool_id
        entry = self.mounts().get(str(path))
        require(entry is not None and entry["filesystem"] in ("ext4", "btrfs"), "Storage pool is not mounted with a supported filesystem", 409, "conflict")
        require(path.resolve() == path, "Storage pool must not contain symlinks")
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW)
        try:
            require(self.fd_mount_id(fd) == entry["id"], "Storage pool mount identity changed", 409, "conflict")
        finally:
            os.close(fd)
        self.assert_exports_safe(path)
        return path, entry

    @staticmethod
    def fd_mount_id(fd):
        # Btrfs subvolumes can have a virtual st_dev different from mountinfo's
        # major:minor. The opened descriptor's mount ID identifies the exact
        # mounted object without treating that legitimate difference as stale.
        try:
            for line in Path(f"/proc/self/fdinfo/{fd}").read_text().splitlines():
                if line.startswith("mnt_id:"):
                    return line.split()[1]
        except OSError:
            pass
        raise ManagerError("Cannot verify storage pool mount identity", 503, "unavailable")

    def assert_exports_safe(self, pool):
        # Old active exports can predate the share renderer's root-squash rule.
        # A root-capable NFS client could bypass directory mode0700, so refuse
        # storage under such an ancestor until that export has been reapplied.
        for exports in self.exports:
            try:
                content = Path(exports).read_text()
            except FileNotFoundError:
                continue
            except OSError:
                raise ManagerError("Cannot verify active NFS export permissions", 503, "unavailable") from None
            for line in content.splitlines():
                if not line.strip() or line.lstrip().startswith("#"):
                    continue
                fields = line.split(maxsplit=1)
                if len(fields) != 2:
                    continue
                export = Path(os.path.normpath(re.sub(r"\\([0-7]{3})", lambda match: chr(int(match[1], 8)), fields[0])))
                if export != pool and export not in pool.parents:
                    continue
                options = fields[1]
                require(not re.search(r"(?:^|[,\s(])(?:no_root_squash|anonuid=0)(?:$|[,\s)])", options),
                        "Reapply ancestor NFS exports with root squashing before using iSCSI images", 409, "conflict")

    def image_directory(self, pool_id, create=False):
        path, mount = self.pool_info(pool_id)
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW)
        pool_fd = os.dup(fd)
        internal_fd = None
        try:
            require(self.fd_mount_id(pool_fd) == mount["id"], "Storage pool mount identity changed", 409, "conflict")
            for component in (".cyberos", "iscsi"):
                made = False
                try:
                    child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW, dir_fd=fd)
                except FileNotFoundError:
                    if not create:
                        raise
                    try:
                        os.mkdir(component, mode=0o755 if component == ".cyberos" else 0o700, dir_fd=fd)
                        made = True
                    except FileExistsError:
                        pass
                    child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW, dir_fd=fd)
                entry = os.fstat(child)
                if (component == "iscsi" and entry.st_uid != os.geteuid()) or entry.st_dev != os.fstat(fd).st_dev:
                    os.close(child)
                    raise ManagerError("iSCSI image directory is unsafe")
                if create and component == "iscsi":
                    os.fchmod(child, 0o700)
                elif component == ".cyberos" and made:
                    os.fchmod(child, 0o755)
                elif component == "iscsi":
                    require(not entry.st_mode & 0o077, "iSCSI image directory permissions are unsafe")
                if component == ".cyberos":
                    internal_fd = os.dup(child)
                os.close(fd)
                fd = child
            self.protect_internal_directory(internal_fd, create=create)
            current_parent = os.stat(".cyberos", dir_fd=pool_fd, follow_symlinks=False)
            protected_parent = os.fstat(internal_fd)
            current_child = os.stat("iscsi", dir_fd=internal_fd, follow_symlinks=False)
            protected_child = os.fstat(fd)
            current_pool = os.stat(path, follow_symlinks=False)
            protected_pool = os.fstat(pool_fd)
            require((current_parent.st_dev, current_parent.st_ino) == (protected_parent.st_dev, protected_parent.st_ino)
                    and (current_child.st_dev, current_child.st_ino) == (protected_child.st_dev, protected_child.st_ino)
                    and (current_pool.st_dev, current_pool.st_ino) == (protected_pool.st_dev, protected_pool.st_ino),
                    "iSCSI image directory identity changed during protection", 409, "conflict")
            return fd, mount
        except Exception:
            os.close(fd)
            raise
        finally:
            if internal_fd is not None:
                os.close(internal_fd)
            os.close(pool_fd)

    @staticmethod
    def protect_internal_directory(fd, create=False):
        # POSIX mode0700 protects image contents, but does not stop an SMB/NFS
        # principal with write access to an ancestor from renaming the entire
        # directory. Immutable on the root-owned .cyberos inode protects both
        # ancestor entries while keeping files inside iscsi mutable for LIO.
        require(sys.platform == "linux" and os.fstat(fd).st_uid == 0,
                "iSCSI requires a root-owned protected .cyberos directory", 409, "conflict")
        flags = array.array("L", [0])
        try:
            fcntl.ioctl(fd, 0x80086601, flags, True)
            if create and not flags[0] & 0x00000010:  # FS_IMMUTABLE_FL
                flags[0] |= 0x00000010
                fcntl.ioctl(fd, 0x40086602, flags)
                os.fsync(fd)
                flags = array.array("L", [0])
                fcntl.ioctl(fd, 0x80086601, flags, True)
            require(flags[0] & 0x00000010,
                    "iSCSI internal directory protection is unavailable", 409, "conflict")
        except OSError:
            raise ManagerError("Filesystem cannot protect iSCSI internal directory entries", 409, "conflict") from None

    def check_image(self, image):
        fd, _ = self.image_directory(image["storagePoolId"])
        try:
            image_fd = os.open(image["id"] + ".img", os.O_RDONLY | NOFOLLOW, dir_fd=fd)
            try:
                entry = os.fstat(image_fd)
                require(stat.S_ISREG(entry.st_mode) and entry.st_uid == os.geteuid() and entry.st_nlink == 1 and entry.st_size == image["sizeBytes"] and not entry.st_mode & 0o077,
                        "iSCSI image is unsafe or has changed", 409, "conflict")
            finally:
                os.close(image_fd)
        finally:
            os.close(fd)

    def allocate(self, image):
        fd, mount = self.image_directory(image["storagePoolId"], create=True)
        name = image["id"] + ".img"
        created = False
        try:
            disk = os.statvfs(fd)
            require(disk.f_bavail * disk.f_frsize >= image["sizeBytes"], "Storage pool has insufficient free space", 409, "conflict")
            image_fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW, 0o600, dir_fd=fd)
            created = True
            try:
                os.fchmod(image_fd, 0o600)
                if mount["filesystem"] == "btrfs":
                    flags = array.array("L", [0])
                    fcntl.ioctl(image_fd, 0x80086601, flags, True)
                    flags[0] |= 0x00800000  # FS_NOCOW_FL; set before writing or allocating extents.
                    fcntl.ioctl(image_fd, 0x40086602, flags)
                os.posix_fallocate(image_fd, 0, image["sizeBytes"])
                os.fsync(image_fd)
            finally:
                os.close(image_fd)
            os.fsync(fd)
        except Exception:
            if created:
                os.unlink(name, dir_fd=fd)
                os.fsync(fd)
            raise
        finally:
            os.close(fd)

    def unlink_image(self, image, missing_ok=False):
        fd, _ = self.image_directory(image["storagePoolId"])
        try:
            name = image["id"] + ".img"
            try:
                entry = os.stat(name, dir_fd=fd, follow_symlinks=False)
            except FileNotFoundError:
                if missing_ok:
                    return
                raise
            require(stat.S_ISREG(entry.st_mode) and entry.st_uid == os.geteuid() and entry.st_nlink == 1, "Refusing to destroy an unsafe image")
            os.unlink(name, dir_fd=fd)
            os.fsync(fd)
        finally:
            os.close(fd)

    def validate_target(self, target, local=True):
        require(valid_name(target.get("name")), "Target name must contain 1 to 64 printable characters")
        try:
            address = ipaddress.ip_address(target["address"])
        except (ValueError, KeyError, TypeError):
            raise ManagerError("Choose a local unicast listen address") from None
        require(not (address.is_unspecified or address.is_multicast or address.is_loopback or address.is_link_local), "Choose a local unicast listen address")
        require(not local or str(address) in self.addresses, "Listen address is no longer available", 409, "conflict")
        require(type(target.get("port")) is int and 1 <= target["port"] <= 65535, "Invalid iSCSI port")
        initiators = target.get("initiators")
        require(isinstance(initiators, list) and 1 <= len(initiators) <= 64 and len(set(initiators)) == len(initiators)
                and all(isinstance(item, str) and len(item) <= 223 and IQN.fullmatch(item) for item in initiators), "Configure a nonempty Initiator IQN whitelist")
        chap = target.get("chap")
        require(exact(chap, ("enabled", "username"), ("password",)) and type(chap["enabled"]) is bool and isinstance(chap["username"], str), "Invalid CHAP configuration")
        if chap["enabled"]:
            require(1 <= len(chap["username"]) <= 128 and all(33 <= ord(c) <= 126 for c in chap["username"]), "CHAP username must contain printable ASCII without spaces")
            require(isinstance(chap.get("password"), str) and 12 <= len(chap["password"]) <= 16 and all(32 <= ord(c) <= 126 for c in chap["password"]), "CHAP requires a 12 to 16 character ASCII password")
        else:
            require("password" not in chap or isinstance(chap["password"], str), "Invalid CHAP password")

    def summary(self, state):
        committed_revision = revision(state)
        pending = self.load_file("pending.json")
        pending_changed = set()
        if pending is not None:
            require(exact(pending, ("previous", "desired", "created", "destroyed")), "iSCSI recovery journal is invalid", 503, "unavailable")
            self.validate_state(pending["desired"])
            _, _, pending_changed = self.changed_targets(pending["previous"], pending["desired"])
            # Keep an interrupted newly enabled target visible so its clients
            # can disconnect. Mutations remain blocked by recover() until the
            # journal is resolved; its proposed configuration is provisional.
            state = pending["desired"]
        available = self.backend.available()
        pools = []
        try:
            candidates = self.data_root.iterdir()
            for path in sorted(candidates):
                if not POOL_ID.fullmatch(path.name) or path.name == "backup":
                    continue
                try:
                    pool, _ = self.pool_info(path.name)
                    disk = os.statvfs(pool)
                    pools.append({"id": path.name, "name": path.name, "availableBytes": disk.f_bavail * disk.f_frsize, "ready": True})
                except (OSError, ManagerError):
                    pools.append({"id": path.name, "name": path.name, "availableBytes": None, "ready": False})
        except OSError:
            pass
        targets = []
        for target in state["targets"]:
            error = None
            sessions = []
            running = False
            if available:
                try:
                    sessions = self.backend.sessions(target)
                    running = self.backend.exists(target)
                    if target["enabled"]:
                        self.validate_target(target)
                        for lun in target["luns"]:
                            self.check_image(next(image for image in state["images"] if image["id"] == lun["imageId"]))
                except Exception:
                    error = "Target storage or listen address is unavailable"
            else:
                error = "LIO kernel support or python3-rtslib-fb is unavailable"
            if target["enabled"] and not running and error is None:
                error = "Target is awaiting recovery"
            if target["id"] in pending_changed:
                error = "Target recovery is pending; disconnect its clients before retrying"
            public = {key: copy.deepcopy(target[key]) for key in ("id", "name", "iqn", "address", "port", "enabled", "initiators", "luns")}
            public.update(chapEnabled=target["chap"]["enabled"], chapUsername=target["chap"]["username"] if target["chap"]["enabled"] else None,
                          credentialConfigured=bool(target["chap"].get("password")), status="degraded" if error else "running" if running else "disabled", error=error, sessions=sessions)
            targets.append(public)
        return {"collectedAt": datetime.now(timezone.utc).isoformat(), "revision": committed_revision, "available": available,
                "error": "An interrupted iSCSI operation is awaiting recovery" if pending else None if available else "LIO kernel support or python3-rtslib-fb is unavailable", "listenAddresses": self.addresses,
                "pools": pools, "targets": targets, "images": copy.deepcopy(state["images"])}

    def changed_targets(self, previous, desired):
        old = {target["id"]: target for target in previous["targets"]}
        new = {target["id"]: target for target in desired["targets"]}
        return old, new, {key for key in old.keys() | new.keys() if old.get(key) != new.get(key)}

    def apply_transition(self, previous, desired):
        old, new, changed = self.changed_targets(previous, desired)
        for target_id in changed:
            if target_id in old:
                require(not self.backend.sessions(old[target_id]), "Disconnect active iSCSI clients first", 409, "conflict")
                self.backend.remove(old[target_id])
        for target_id in changed:
            if target_id in new:
                self.backend.apply(new[target_id], desired["images"], replace=True)

    def recover(self):
        pending = self.load_file("pending.json")
        if pending is None:
            return
        require(exact(pending, ("previous", "desired", "created", "destroyed")), "iSCSI recovery journal is invalid", 503, "unavailable")
        self.validate_state(pending["previous"])
        self.validate_state(pending["desired"])
        old_ids = {image["id"] for image in pending["previous"]["images"]}
        new_ids = {image["id"] for image in pending["desired"]["images"]}
        require(isinstance(pending["created"], list) and isinstance(pending["destroyed"], list)
                and pending["created"] == [image for image in pending["desired"]["images"] if image["id"] not in old_ids]
                and {image["id"] for image in pending["destroyed"]} == old_ids - new_ids,
                "iSCSI recovery image registry is invalid", 503, "unavailable")
        for image in pending["destroyed"]:
            previous_image = next(item for item in pending["previous"]["images"] if item["id"] == image["id"])
            require({**image, "attachedTargetId": previous_image["attachedTargetId"]} == previous_image,
                    "iSCSI recovery image registry is invalid", 503, "unavailable")
        require(self.backend.available(), "LIO is unavailable while recovering an iSCSI operation", 503, "unavailable")
        state = self.load()
        if revision(state) == revision(pending["desired"]):
            for image in pending["destroyed"]:
                self.unlink_image(image, missing_ok=True)
        else:
            require(revision(state) == revision(pending["previous"]), "iSCSI recovery revision does not match", 503, "unavailable")
            self.apply_transition(pending["desired"], pending["previous"])
            for image in pending["created"]:
                self.unlink_image(image, missing_ok=True)
        (self.state_dir / "pending.json").unlink()
        self.sync_directory(self.state_dir)

    def handle(self, request):
        require(isinstance(request, dict), "Invalid iSCSI request")
        action = request.get("action")
        if action == "read":
            require(exact(request, ("action",)), "Invalid read request")
            return self.summary(self.load())
        if action == "reconcile":
            self.recover()
            state = self.load()
            if self.backend.available():
                for target in state["targets"]:
                    if target["enabled"] and not self.backend.exists(target):
                        try:
                            self.validate_target(target)
                            for lun in target["luns"]:
                                self.check_image(next(image for image in state["images"] if image["id"] == lun["imageId"]))
                            self.backend.apply(target, state["images"])
                        except Exception:
                            pass  # A missing pool/address degrades only this target and is retried.
            return self.summary(state)
        fields = {
            "create_target": (("name", "address", "port", "initiators", "chap", "enabled"), ()),
            "update_target": (("targetId", "name", "address", "port", "initiators", "chap"), ()),
            "set_target_enabled": (("targetId", "enabled"), ()),
            "delete_target": (("targetId", "destroyImages"), ("confirmation",)),
            "create_lun": (("targetId", "name", "storagePoolId", "sizeBytes"), ()),
            "attach_lun": (("targetId", "imageId"), ()),
            "detach_lun": (("targetId", "imageId", "destroyImage"), ("confirmation",)),
            "destroy_image": (("imageId", "confirmation"), ()),
        }
        require(action in fields, "Unknown iSCSI action")
        required, optional = fields[action]
        require(exact(request, ("action", "confirmed", "expectedRevision") + required, optional), "Invalid iSCSI action fields")
        require(request["confirmed"] is True, "Explicit confirmation is required")
        require(self.backend.available(), "LIO kernel support or python3-rtslib-fb is unavailable", 503, "unavailable")
        self.recover()
        previous = self.load()
        require(request["expectedRevision"] == revision(previous), "iSCSI configuration changed; refresh before saving", 409, "conflict")
        state = copy.deepcopy(previous)
        created, destroyed = [], []
        target = None
        image = None
        if "targetId" in request:
            require(identifier(request["targetId"]), "Invalid target ID")
            target = next((item for item in state["targets"] if item["id"] == request["targetId"]), None)
            require(target is not None, "Target no longer exists", 404, "not_found")
            require(not self.backend.sessions(target), "Disconnect active iSCSI clients first", 409, "conflict")
        if "imageId" in request:
            require(identifier(request["imageId"]), "Invalid image ID")
            image = next((item for item in state["images"] if item["id"] == request["imageId"]), None)
            require(image is not None, "Image no longer exists", 404, "not_found")
        if action in ("create_target", "update_target"):
            updated = {key: copy.deepcopy(request[key]) for key in ("name", "address", "port", "initiators", "chap")}
            if action == "update_target" and "password" not in updated["chap"] and updated["chap"]["enabled"]:
                updated["chap"]["password"] = target["chap"].get("password")
            if not updated["chap"]["enabled"]:
                updated["chap"] = {"enabled": False, "username": ""}
            self.validate_target(updated)
            require(not any(item["name"] == updated["name"] and item is not target for item in state["targets"]), "Target name already exists", 409, "conflict")
            if action == "create_target":
                require(type(request["enabled"]) is bool, "Invalid target enable state")
                target_id = str(uuid.uuid4())
                state["targets"].append({**updated, "id": target_id, "iqn": TARGET_PREFIX + target_id, "enabled": request["enabled"], "luns": []})
            else:
                target.update(updated)
        elif action == "set_target_enabled":
            require(type(request["enabled"]) is bool, "Invalid target enable state")
            target["enabled"] = request["enabled"]
        elif action == "delete_target":
            require(type(request["destroyImages"]) is bool, "Invalid image destruction option")
            if request["destroyImages"]:
                require(request.get("confirmation") == target["name"], "Type the Target name to confirm destruction")
            for item in state["images"][:]:
                if item["attachedTargetId"] == target["id"]:
                    item["attachedTargetId"] = None
                    if request["destroyImages"]:
                        destroyed.append(item)
                        state["images"].remove(item)
            state["targets"].remove(target)
        elif action == "create_lun":
            require(valid_name(request["name"]), "LUN name must contain 1 to 64 printable characters")
            size = request["sizeBytes"]
            require(type(size) is int and GIB <= size <= MAX_BYTES and size % GIB == 0, "Capacity must be a positive whole GiB")
            self.pool_info(request["storagePoolId"])
            # Establish the directory invariant before journaling an image.
            # Otherwise an unsupported immutable flag would also prevent
            # rollback cleanup and poison unrelated subsequent operations.
            try:
                directory_fd, _ = self.image_directory(request["storagePoolId"], create=True)
            except OSError:
                raise ManagerError("iSCSI image directory is unsafe or unavailable", 409, "conflict") from None
            os.close(directory_fd)
            image = {"id": str(uuid.uuid4()), "name": request["name"], "storagePoolId": request["storagePoolId"], "sizeBytes": size, "attachedTargetId": target["id"]}
            state["images"].append(image)
            created.append(image)
            self.attach(target, image)
        elif action == "attach_lun":
            require(image["attachedTargetId"] is None, "Image is already attached to a Target", 409, "conflict")
            self.check_image(image)
            image["attachedTargetId"] = target["id"]
            self.attach(target, image)
        elif action == "detach_lun":
            require(type(request["destroyImage"]) is bool, "Invalid image destruction option")
            require(image["attachedTargetId"] == target["id"], "Image does not belong to this Target")
            if request["destroyImage"]:
                require(request.get("confirmation") == image["name"], "Type the image name to confirm destruction")
                state["images"].remove(image)
                destroyed.append(image)
            image["attachedTargetId"] = None
            target["luns"] = [lun for lun in target["luns"] if lun["imageId"] != image["id"]]
        elif action == "destroy_image":
            require(image["attachedTargetId"] is None, "Detach the image before destroying it", 409, "conflict")
            require(request["confirmation"] == image["name"], "Type the image name to confirm destruction")
            state["images"].remove(image)
            destroyed.append(image)
        for item in destroyed:
            self.check_image(item)
        old, new, changed = self.changed_targets(previous, state)
        for target_id in changed:
            item = new.get(target_id)
            if item and item["enabled"]:
                self.validate_target(item)
                for lun in item["luns"]:
                    linked = next(candidate for candidate in state["images"] if candidate["id"] == lun["imageId"])
                    if linked not in created:
                        self.check_image(linked)
        journal = {"previous": previous, "desired": state, "created": created, "destroyed": destroyed}
        self.write("pending.json", journal)
        try:
            for item in created:
                self.allocate(item)
            self.apply_transition(previous, state)
            self.write("state.json", state)
            for item in destroyed:
                self.unlink_image(item)
            (self.state_dir / "pending.json").unlink()
            self.sync_directory(self.state_dir)
        except Exception as error:
            try:
                self.recover()
            except Exception:
                pass  # Keep the journal for startup recovery; subsequent mutations fail closed.
            if isinstance(error, ManagerError):
                raise
            raise ManagerError("iSCSI operation failed; refresh and inspect hostd before retrying", 502, "operation_failed") from None
        return self.summary(state)

    @staticmethod
    def attach(target, image):
        used = {lun["lun"] for lun in target["luns"]}
        number = next((number for number in range(256) if number not in used), None)
        require(number is not None, "Target has reached its LUN limit", 409, "conflict")
        target["luns"].append({"imageId": image["id"], "lun": number})


def main():
    try:
        require(os.geteuid() == 0, "iSCSI helper requires hostd", 403, "forbidden")
        raw = sys.stdin.buffer.read(1024 * 1024 + 1)
        require(len(raw) <= 1024 * 1024, "iSCSI request is too large")
        value = json.loads(raw)
        require(exact(value, ("dataRoot", "request")), "Invalid helper request")
        manager = Manager(value["dataRoot"])
        # The Rust storage mutex is authoritative. This also serializes recovery if
        # administrators invoke this fixed helper concurrently for diagnostics.
        lock_fd = os.open(manager.state_dir / "lock", os.O_CREAT | os.O_RDWR | NOFOLLOW, 0o600)
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX)
            result = manager.handle(value["request"])
        finally:
            os.close(lock_fd)
        output = {"ok": True, "result": result}
    except ManagerError as error:
        output = {"ok": False, "error": {"status": error.status, "code": error.code, "message": str(error)}}
    except Exception:
        output = {"ok": False, "error": {"status": 503, "code": "unavailable", "message": "iSCSI managed state or runtime is unavailable"}}
    print(json.dumps(output))


if __name__ == "__main__":
    main()
