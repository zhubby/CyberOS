import copy
import importlib.util
import json
import os
import stat
import sys
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("iscsi", Path(__file__).with_name("iscsi.py"))
iscsi = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(iscsi)


class FakeBackend:
    def __init__(self):
        self.targets = {}
        self.active = {}
        self.fail = False

    def available(self):
        return True

    def sessions(self, target):
        return self.active.get(target["id"], [])

    def exists(self, target):
        return target["id"] in self.targets

    def apply(self, target, images, replace=False):
        if self.fail:
            raise RuntimeError("password=secret-value")
        if target["enabled"]:
            self.targets[target["id"]] = copy.deepcopy(target)

    def remove(self, target):
        self.targets.pop(target["id"], None)


class ManagerTests(unittest.TestCase):
    def setUp(self):
        protection = patch.object(iscsi.Manager, "protect_internal_directory", return_value=None)
        protection.start()
        self.addCleanup(protection.stop)
        mount_id = patch.object(iscsi.Manager, "fd_mount_id", return_value="1")
        mount_id.start()
        self.addCleanup(mount_id.stop)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.data = self.root / "data"
        self.pool = self.data / "pool-1"
        self.pool.mkdir(parents=True)
        self.mountinfo = self.root / "mountinfo"
        device = self.pool.stat().st_dev
        self.mount_line = f"1 0 {os.major(device)}:{os.minor(device)} / {self.pool} rw - ext4 /dev/test rw\n"
        self.mountinfo.write_text(self.mount_line)
        self.backend = FakeBackend()
        self.manager = iscsi.Manager(self.data, self.backend, self.mountinfo, addresses=["192.0.2.10"])

    def request(self, action, **fields):
        return self.manager.handle({"action": action, "confirmed": True,
                                    "expectedRevision": self.manager.handle({"action": "read"})["revision"], **fields})

    def target(self, name="target"):
        result = self.request("create_target", name=name, address="192.0.2.10", port=3260,
                              initiators=["iqn.2026-10.example:client"],
                              chap={"enabled": True, "username": "client", "password": "secret-value1"}, enabled=True)
        return result["targets"][-1]

    def image(self, target):
        with patch.object(iscsi.os, "posix_fallocate", side_effect=lambda fd, offset, length: os.ftruncate(fd, length), create=True):
            return self.request("create_lun", targetId=target["id"], name="disk", storagePoolId="pool-1", sizeBytes=1024**3)["images"][-1]

    def test_revision_confirmation_and_secrets(self):
        before = self.manager.handle({"action": "read"})["revision"]
        target = self.target()
        self.assertTrue(target["credentialConfigured"])
        self.assertNotIn("secret-value", json.dumps(self.manager.handle({"action": "read"})))
        with self.assertRaises(iscsi.ManagerError) as stale:
            self.manager.handle({"action": "set_target_enabled", "targetId": target["id"], "enabled": False,
                                 "confirmed": True, "expectedRevision": before})
        self.assertEqual(stale.exception.status, 409)
        with self.assertRaises(iscsi.ManagerError):
            self.manager.handle({"action": "set_target_enabled", "targetId": target["id"], "enabled": False,
                                 "confirmed": False, "expectedRevision": before})

    def test_retained_image_can_only_attach_once_and_can_be_destroyed(self):
        first = self.target()
        image = self.image(first)
        second = self.target("second")
        with self.assertRaises(iscsi.ManagerError):
            self.request("attach_lun", targetId=second["id"], imageId=image["id"])
        result = self.request("delete_target", targetId=first["id"], destroyImages=False)
        self.assertIsNone(result["images"][0]["attachedTargetId"])
        result = self.request("attach_lun", targetId=second["id"], imageId=image["id"])
        self.assertEqual(result["images"][0]["attachedTargetId"], second["id"])
        with self.assertRaises(iscsi.ManagerError):
            self.request("detach_lun", targetId=second["id"], imageId=image["id"], destroyImage=True, confirmation="wrong")
        result = self.request("detach_lun", targetId=second["id"], imageId=image["id"], destroyImage=True, confirmation="disk")
        self.assertEqual(result["images"], [])

    def test_sessions_block_all_disruptive_changes(self):
        target = self.target()
        self.backend.active[target["id"]] = [{"initiator": "iqn.2026-10.example:client", "address": None}]
        for action, fields in [("set_target_enabled", {"enabled": False}),
                               ("delete_target", {"destroyImages": False}),
                               ("create_lun", {"name": "disk", "storagePoolId": "pool-1", "sizeBytes": 1024**3})]:
            with self.subTest(action=action), self.assertRaises(iscsi.ManagerError) as error:
                self.request(action, targetId=target["id"], **fields)
            self.assertEqual(error.exception.status, 409)

    def test_allocation_failure_cleans_new_file_and_registry(self):
        target = self.target()
        with patch.object(iscsi.os, "posix_fallocate", side_effect=OSError("disk full"), create=True):
            with self.assertRaises(iscsi.ManagerError):
                self.request("create_lun", targetId=target["id"], name="disk", storagePoolId="pool-1", sizeBytes=1024**3)
        self.assertEqual(self.manager.handle({"action": "read"})["images"], [])
        self.assertEqual(list((self.pool / ".cyberos" / "iscsi").glob("*.img")), [])

    def test_unmounted_pool_and_symlink_path_are_rejected(self):
        target = self.target()
        self.mountinfo.write_text("")
        with self.assertRaises(iscsi.ManagerError):
            self.image(target)
        self.mountinfo.write_text(self.mount_line)
        (self.pool / ".cyberos").symlink_to(self.root)
        with self.assertRaises(iscsi.ManagerError):
            self.image(target)

    def test_failed_apply_rolls_back_configuration_without_leaking_error(self):
        target = self.target()
        self.backend.fail = True
        with self.assertRaises(iscsi.ManagerError) as error:
            self.request("update_target", targetId=target["id"], name="updated", address="192.0.2.10", port=3260,
                         initiators=["iqn.2026-10.example:client"], chap={"enabled": True, "username": "client"})
        self.assertNotIn("secret-value", str(error.exception))
        self.assertEqual(self.manager.load()["targets"][0]["name"], "target")

    def test_missing_runtime_is_degraded_and_reconciles_when_ready(self):
        target = self.target()
        self.image(target)
        self.backend.targets.clear()
        self.manager.handle({"action": "reconcile"})
        self.assertTrue(self.backend.exists(target))
        self.mountinfo.write_text("")
        self.assertEqual(self.manager.handle({"action": "read"})["targets"][0]["status"], "degraded")

    def test_disable_and_reenable_preserves_iqn_lun_ids_and_credential(self):
        target = self.target()
        image = self.image(target)
        disabled = self.request("set_target_enabled", targetId=target["id"], enabled=False)["targets"][0]
        self.assertEqual(disabled["status"], "disabled")
        enabled = self.request("set_target_enabled", targetId=target["id"], enabled=True)["targets"][0]
        self.assertEqual(enabled["iqn"], target["iqn"])
        self.assertEqual(enabled["luns"], [{"imageId": image["id"], "lun": 0}])
        self.assertTrue(enabled["credentialConfigured"])

    def test_pending_uncommitted_allocation_recovers_without_orphan_image(self):
        target = self.target()
        previous = self.manager.load()
        desired = copy.deepcopy(previous)
        image = {"id": "27f9f605-a5e5-4421-84f1-8b41d8973710", "name": "new", "storagePoolId": "pool-1", "sizeBytes": 1024**3, "attachedTargetId": target["id"]}
        desired["images"].append(image)
        desired["targets"][0]["luns"].append({"imageId": image["id"], "lun": 0})
        self.manager.write("pending.json", {"previous": previous, "desired": desired, "created": [image], "destroyed": []})
        with patch.object(iscsi.os, "posix_fallocate", side_effect=lambda fd, offset, length: os.ftruncate(fd, length), create=True):
            self.manager.allocate(image)
        self.manager.recover()
        self.assertFalse((self.pool / ".cyberos" / "iscsi" / (image["id"] + ".img")).exists())
        self.assertEqual(self.manager.load(), previous)
        self.assertFalse((self.manager.state_dir / "pending.json").exists())

    def test_committed_destroy_recovery_finishes_cleanup_idempotently(self):
        target = self.target()
        image = self.image(target)
        previous = self.manager.load()
        desired = copy.deepcopy(previous)
        desired["images"] = []
        desired["targets"][0]["luns"] = []
        removed = {**image, "attachedTargetId": None}
        self.manager.write("pending.json", {"previous": previous, "desired": desired, "created": [], "destroyed": [removed]})
        self.manager.write("state.json", desired)
        self.manager.recover()
        self.manager.recover()
        self.assertFalse((self.pool / ".cyberos" / "iscsi" / (image["id"] + ".img")).exists())

    def test_state_and_image_symlinks_and_wrong_mount_identity_fail_closed(self):
        target = self.target()
        image = self.image(target)
        path = self.pool / ".cyberos" / "iscsi" / (image["id"] + ".img")
        path.unlink()
        path.symlink_to(self.manager.state_dir / "state.json")
        with self.assertRaises(OSError):
            self.manager.check_image(image)
        self.mountinfo.write_text(f"2 0 0:0 / {self.pool} rw - ext4 /dev/test rw\n")
        with self.assertRaises(iscsi.ManagerError):
            self.manager.pool_info("pool-1")

    def test_btrfs_virtual_device_is_accepted_only_with_matching_open_mount_id(self):
        self.mountinfo.write_text(f"1 0 0:999 / {self.pool} rw - btrfs /dev/test rw\n")
        self.assertEqual(self.manager.pool_info("pool-1")[1]["filesystem"], "btrfs")
        with patch.object(iscsi.Manager, "fd_mount_id", return_value="2"):
            with self.assertRaises(iscsi.ManagerError):
                self.manager.pool_info("pool-1")

    def test_parent_rename_during_protection_is_rejected_before_journaling(self):
        target = self.target()
        def rename_parent(fd, create=False):
            (self.pool / ".cyberos").rename(self.pool / "moved")
            (self.pool / ".cyberos").mkdir()
        with patch.object(iscsi.Manager, "protect_internal_directory", side_effect=rename_parent):
            with self.assertRaises(iscsi.ManagerError):
                self.image(target)
        self.assertIsNone(self.manager.load_file("pending.json"))
        self.assertEqual(self.manager.load()["images"], [])

    def test_inadequate_free_space_prevents_allocation(self):
        target = self.target()
        with patch.object(iscsi.os, "statvfs") as disk:
            disk.return_value.f_bavail = 0
            disk.return_value.f_frsize = 4096
            with self.assertRaises(iscsi.ManagerError):
                self.request("create_lun", targetId=target["id"], name="new", storagePoolId="pool-1", sizeBytes=1024**3)
        self.assertEqual(self.manager.load()["images"], [])

    def test_unsupported_directory_protection_does_not_poison_other_mutations(self):
        target = self.target()
        with patch.object(iscsi.Manager, "protect_internal_directory", side_effect=iscsi.ManagerError("Unsupported protection", 409, "conflict")):
            with self.assertRaises(iscsi.ManagerError):
                self.image(target)
        self.assertIsNone(self.manager.load_file("pending.json"))
        self.assertEqual(self.manager.load()["images"], [])
        self.assertEqual(len(self.target("unrelated")["initiators"]), 1)

    def test_only_image_subdirectory_is_private_so_regular_backups_can_traverse_parent(self):
        target = self.target()
        previous = os.umask(0o077)
        try:
            image = self.image(target)
        finally:
            os.umask(previous)
        internal = self.pool / ".cyberos"
        self.assertEqual(stat.S_IMODE(internal.stat().st_mode), 0o755)
        self.assertEqual(stat.S_IMODE((internal / "iscsi").stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE((internal / "iscsi" / (image["id"] + ".img")).stat().st_mode), 0o600)

    def test_tampered_recovery_journal_refuses_unregistered_destruction(self):
        self.target()
        state = self.manager.load()
        self.manager.write("pending.json", {"previous": state, "desired": state, "created": [], "destroyed": [{"id": "../state", "storagePoolId": "pool-1"}]})
        with self.assertRaises(iscsi.ManagerError):
            self.manager.recover()

    def test_existing_unsquashed_nfs_ancestor_blocks_image_storage(self):
        target = self.target()
        exports = self.root / "exports"
        exports.write_text(f"{self.pool} 192.0.2.0/24(rw,no_root_squash,no_subtree_check)\n")
        self.manager.exports = (exports,)
        with self.assertRaises(iscsi.ManagerError) as error:
            self.image(target)
        self.assertEqual(error.exception.status, 409)
        exports.write_text(f"{self.pool} 192.0.2.0/24(rw,root_squash,no_subtree_check)\n")
        image = self.image(target)
        self.assertEqual(image["storagePoolId"], "pool-1")

    @unittest.skipUnless(os.geteuid() == 0, "production ownership check requires root")
    def test_existing_cyberos_owned_state_root_is_accepted(self):
        os.chown(self.root / "state", 65534, 65534)
        manager = iscsi.Manager(self.data, self.backend, self.mountinfo, addresses=[])
        self.assertEqual(manager.load()["images"], [])

    def test_rejects_wildcard_addresses_empty_acl_unknown_fields_and_path_ids(self):
        for patch_value in [{"address": "0.0.0.0"}, {"initiators": []}, {"storagePoolId": "../outside"}]:
            with self.subTest(patch_value=patch_value), self.assertRaises(iscsi.ManagerError):
                self.request("create_target", name="target", address=patch_value.get("address", "192.0.2.10"), port=3260,
                             initiators=patch_value.get("initiators", ["iqn.2026-10.example:client"]),
                             chap={"enabled": False, "username": ""}, enabled=True,
                             **({"storagePoolId": patch_value["storagePoolId"]} if "storagePoolId" in patch_value else {}))


@unittest.skipUnless(sys.platform == "linux" and os.geteuid() == 0, "immutable protection requires Linux root")
class ImmutableDirectoryTests(unittest.TestCase):
    def test_shared_ancestor_entries_cannot_be_renamed_but_images_remain_writable(self):
        capabilities = next((line.split()[1] for line in Path("/proc/self/status").read_text().splitlines() if line.startswith("CapEff:")), "0")
        if not int(capabilities, 16) & (1 << 9):
            self.skipTest("CAP_LINUX_IMMUTABLE is unavailable")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            internal = root / ".cyberos"
            images = internal / "iscsi"
            images.mkdir(parents=True)
            fd = os.open(internal, os.O_RDONLY | os.O_DIRECTORY)
            try:
                iscsi.Manager.protect_internal_directory(fd, create=True)
                with self.assertRaises(PermissionError):
                    internal.rename(root / "renamed")
                with self.assertRaises(PermissionError):
                    images.rename(internal / "renamed")
                (images / "disk.img").write_bytes(b"LUN content")
                self.assertEqual((images / "disk.img").read_bytes(), b"LUN content")
            finally:
                flags = iscsi.array.array("L", [0])
                iscsi.fcntl.ioctl(fd, 0x80086601, flags, True)
                flags[0] &= ~0x00000010
                iscsi.fcntl.ioctl(fd, 0x40086602, flags)
                os.close(fd)


if __name__ == "__main__":
    unittest.main()
