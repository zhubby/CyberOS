import importlib.util
import pathlib
import tempfile
import unittest

MODULE = pathlib.Path(__file__).with_name("tailscale_forwarding.py")


class TailscaleForwardingTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location("tailscale_forwarding", MODULE)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)

    def test_only_known_enable_operations_are_accepted(self):
        self.assertEqual(self.module.parse_config("# Managed by CyberOS Tailscale\nnet.ipv4.ip_forward = 1\n"), {"net/ipv4/ip_forward"})
        for text in ["net.ipv4.ip_forward=0", "kernel.sysrq=1", "net.ipv4.ip_forward=1;reboot"]:
            with self.assertRaises(ValueError):
                self.module.parse_config(text)

    def test_ipv6_forwarding_preserves_router_advertisements_and_disabled_interfaces(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            for name, value in [("all", "1"), ("default", "1"), ("eth0", "1"), ("eth1", "0"), ("vlan.2", "2")]:
                path = root / "net/ipv6/conf" / name / "accept_ra"
                path.parent.mkdir(parents=True)
                path.write_text(value)
            (root / "net/ipv6/conf/all/forwarding").write_text("0")
            ipv4 = root / "net/ipv4/ip_forward"
            ipv4.parent.mkdir(parents=True)
            ipv4.write_text("1")
            self.module.apply_forwarding({"net/ipv6/conf/all/forwarding"}, root)
            self.assertEqual((root / "net/ipv6/conf/eth0/accept_ra").read_text(), "2")
            self.assertEqual((root / "net/ipv6/conf/eth1/accept_ra").read_text(), "0")
            self.assertEqual((root / "net/ipv6/conf/default/accept_ra").read_text(), "2")
            self.assertEqual((root / "net/ipv6/conf/all/forwarding").read_text(), "1")
            self.assertEqual(ipv4.read_text(), "1")


if __name__ == "__main__":
    unittest.main()
