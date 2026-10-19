use std::collections::HashMap;
use std::sync::OnceLock;

use crate::domain::metric::MetricDefinition;

static CATALOG: OnceLock<Vec<MetricDefinition>> = OnceLock::new();
static BY_NAME: OnceLock<HashMap<String, usize>> = OnceLock::new();

pub fn catalog() -> &'static [MetricDefinition] {
    CATALOG
        .get_or_init(|| {
            serde_json::from_str(include_str!(
                "../../../../packages/monitoring/contracts/metrics-catalog.json"
            ))
            .expect("embedded monitoring catalog must be valid")
        })
        .as_slice()
}

pub fn metric(name: &str) -> Option<&'static MetricDefinition> {
    let by_name = BY_NAME.get_or_init(|| {
        catalog()
            .iter()
            .enumerate()
            .map(|(index, definition)| (definition.name.clone(), index))
            .collect()
    });
    by_name.get(name).map(|index| &catalog()[*index])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_the_shared_catalog() {
        let definition = metric("zos_host_filesystem_used_ratio").unwrap();
        assert_eq!(definition.label_keys, ["filesystem"]);
        assert_eq!(catalog().len(), 29);
    }
}
